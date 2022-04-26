const _ = require('lodash');
const fetch = require('node-fetch')

const { ethers } = require('ethers');
const bn = ethers.BigNumber.from
const ga = ethers.utils.getAddress

const abiIERC20 = require('../abi/ERC20.abi.json')
const abiAggregator = require('../abi/Aggregator.abi.json')

const { StateEngine } = require('./state')
const { getAmountOut } = require('./utils')

const BSC_TOKEN_HUB = '0x0000000000000000000000000000000000001004'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LARGE_VALUE = '0x8000000000000000000000000000000000000000000000000000000000000000'

const CONFIG_DEFAULT = {
    verifier: {
        address: '0x9a7b42f2cC543ab1bcFEB2b9F8b9cB8CC0F38E5F',
        abi: abiAggregator,
        verify: async (context, simulation, ...params) => {
            // return simulation // skip verifcation, use simulated data instead
            const { amountOut, gasLeft } = await context.engine.contract.callStatic.aggregate(...params)
            const gasLimit = params[params.length-1].gasLimit ?? context.engine.config.chain.callGasLimit
            const gasUsed = gasLimit - gasLeft.toNumber()
            return { amountOut, gasUsed }
        },
    },
    route: {
        api: 'https://api.lz.finance/swap/route',
        n: 8, m: 8, l: 64,
        maxIterations: 128,
    },
    chain: {
        provider: new ethers.providers.JsonRpcProvider('https://bsc-dataseed.binance.org'),
        callGasLimit: 20000000,
        loadAMMs: async () => fetch('https://raw.githubusercontent.com/launchzone/configs/main/bsc/amm.json').then(res => res.json()).catch(console.error),
        loadTokens: async () => fetch('https://raw.githubusercontent.com/launchzone/configs/main/bsc/tokens.json').then(res => res.json()).catch(console.error),
        loadLiquidityTokens: async () => fetch('https://raw.githubusercontent.com/launchzone/configs/main/bsc/liquidity-tokens.json').then(res => res.json()).catch(console.error),
        tokens: {
            NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
            WRAPPED: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        },
    },
    debug: false,
}

class SwapEngine {
    constructor(config) {
        this.config = _.merge(CONFIG_DEFAULT, config)
        this.AMMS = this.config.chain.loadAMMs()
        this.contract = new ethers.Contract(this.config.verifier.address, this.config.verifier.abi, this.config.chain.provider)
    }

    async loadPair(tokenIn, tokenOut) {
        if (tokenIn.length != 42 || !tokenIn.startsWith('0x') || tokenOut.length != 42 || !tokenOut.startsWith('0x')) {
            await this.loadTokens()
            tokenIn = this.resolveTokenAddress(tokenIn)
            tokenOut = this.resolveTokenAddress(tokenOut)
        }

        // sanitize inputs
        tokenIn = ga(tokenIn)
        tokenOut = ga(tokenOut)

        const [routes] = await Promise.all([
            this._loadRoutes(tokenIn, tokenOut),
            this._loadTokenFeeRoute(tokenOut),
        ])

        // make sure the AMMS is loadded
        this.AMMS = await Promise.resolve(this.AMMS);

        this.pair = {
            tokenIn,
            tokenOut,
            routes,
        }
    }

    updateLiquidityReserves(rs) {
        this.LiquidityReserves = _.merge(this.LiquidityReserves, rs)
    }

    createSwapContext(context) {
        return new SwapContext(this, context)
    }

    _simulate(routes, dists, amountIn, STEPS) {
        const { tokenOut } = this.pair
        const rr = applyDistsToRoutes(routes, dists, amountIn).filter(r => r?.amount?.gt(0))
        const state = new StateEngine().updateDB(STEPS, this.AMMS, this.LiquidityReserves) // create new statedb
        const [out, outs] = state.swap(rr)

        const stepCount = rr.reduce((stepCount, route) => stepCount + route.steps.length, 0)
        const gasUsed = stepCount * 100000
        const fee = this.stepFee(tokenOut).mul(stepCount + 1)
        const final = out.sub(fee)
        return [out, outs, final, gasUsed]
    }

    _searchWithoutVerify(amountIn, ROUTES) {
        const STEPS = _.flatten(ROUTES.map(route => route.steps))

        const state = new StateEngine().updateDB(STEPS, this.AMMS, this.LiquidityReserves) // create new statedb
        const routes = ROUTES.map(route => {
            let [amountOut] = state.swap([{
                amount: amountIn,
                steps: route.steps,
            }])
            return {
                amountOut,
                steps: route.steps,
            }
        }).sort((b, a) => {
            if (a.amountOut.lt(b.amountOut)) {
                return -1
            }
            if (a.amountOut.gt(b.amountOut)) {
                return 1
            }
            return 0
        })

        const dists = amountsToDists(routes.map(res => res.amountOut))
        if (this.config.debug) console.log('single route', dists)

        let best = _.cloneDeep(dists)
        // best = new Array(dists.length).fill(1 / dists.length)
        let [out, outs, final, gas] = this._simulate(routes, best, amountIn, STEPS)
        if (this.config.debug) console.log(`init`, ethers.utils.formatEther(out), '=>', ethers.utils.formatEther(final))

        for (let i = 0; i < this.config.route.maxIterations; ++i) {
            let aa = amountsToDists(outs)
            let [outA, outsA, finalA, gasA] = this._simulate(routes, aa, amountIn, STEPS)

            function indexOfMinNonZero(arr) {
                if (arr.length === 0) {
                    return -1;
                }

                let min = arr[0];
                let minIndex = 0;

                for (let i = 1; i < arr.length; i++) {
                    if (arr[i] > 0 && arr[i] < min) {
                        minIndex = i;
                        min = arr[i];
                    }
                }

                return minIndex;
            }

            let bb = _.clone(aa)
            const minIndex = indexOfMinNonZero(aa)
            bb[minIndex] = 0
            bb = normalize(bb)

            if (bb.some(b => b > 0)) {
                const [outB, outsB, finalB, gasB] = this._simulate(routes, bb, amountIn, STEPS)
                if (finalB.gt(finalA)) {
                    [outA, outsA, finalA, gasA, aa] = [outB, outsB, finalB, gasB, bb]
                }
            }

            const improvement = finalA.sub(final)
            if (improvement.lte(0)) {
                break
            }
            // if (imporvementPercent < 0.0001) {
            //   break
            // }

            [out, outs, final, gas, best] = [outA, outsA, finalA, gasA, aa]
            const imporvementPercent = improvement.mul(100000000).div(final.abs()).toNumber() / 1000000
            if (this.config.debug) console.log(`(${i}) +${imporvementPercent}%`, aa, ethers.utils.formatEther(out), '=>', ethers.utils.formatEther(final))
        }

        if (this.config.debug) console.log('final')

        return {
            routes,
            dists: best,
            simulation: {
                amountOut: out,
                gasUsed: gas,
            },
        }
    }

    _routeToParam(route, tokenOut, recipient) {
        const r = {
            amount: route.amount,
            entry: route.steps[0].a,
            steps: [],
        }

        for (let i = 0; i < route.steps.length; ++i) {
            const step = route.steps[i]
            const hasNextStep = i + 1 < route.steps.length
            const router = this.resolveRouterAddress(step.c)
            const exit = hasNextStep ? route.steps[i + 1].a : tokenOut == this.config.chain.tokens.NATIVE ? this.config.verifier.address : recipient
            r.steps.push([router, step.ai, step.a, step.ao, exit].map(ga))
        }

        // merge adjenced steps with the same router
        for (let i = r.steps.length - 1; i > 0; --i) {
            if (r.steps[i][0] != r.steps[i - 1][0]) {
                continue
            }
            if (r.steps[i][1] != r.steps[i - 1][r.steps[i - 1].length - 2]) {
                throw {
                    message: 'disconnected path',
                    steps: r.steps,
                }
            }
            r.steps[i - 1].push(...r.steps[i].slice(3))
            r.steps.splice(i, 1)
        }

        return r
    }

    _routesToParams(amountIn, tokenOut, recipient, routes, dists) {
        routes = applyDistsToRoutes(routes, dists, amountIn)
        routes = routes.filter(route => route.amount?.gt(0))
        const routesParam = routes.map(route => this._routeToParam(route, tokenOut, recipient))
        return routesParam
    }

    async _loadRoutes(tokenIn, tokenOut) {
        const apiTokenOut = tokenOut == this.config.chain.tokens.NATIVE ? this.config.chain.tokens.WRAPPED : tokenOut
        const apiTokenIn = tokenIn == this.config.chain.tokens.NATIVE ? this.config.chain.tokens.WRAPPED : tokenIn
        if (apiTokenIn == apiTokenOut) {
            throw new Error('tokenIn == tokenOut')
        }

        const { n, m, l } = this.config.route
        const routes = await fetch(`${this.config.route.api}/${apiTokenIn}/${apiTokenOut}?n=${n}&m=${m}&l=${l}`)
            .then(res => res.json())
            .then(routes => routes.map(route => {
                const steps = route.route
                steps.forEach(step => {
                    step.ai = ga(step.ai)
                    step.ao = ga(step.ao)
                    step.a = ga(step.a)
                    step.c = ga(step.c)
                    step.ri = bn(step.ri)
                    step.ro = bn(step.ro)
                })
                return {
                    liquidity: bn(route.liquidity),
                    steps,
                }
            }))

        return routes
    }

    _bnbToToken(token, amount) {
        if ([this.config.chain.tokens.NATIVE, this.config.chain.tokens.WRAPPED].includes(token)) {
            return amount
        }

        if (this.tokenFeeRoutes[token]?.steps == null) {
            throw new Error('SmartRoutingEngine: uninitilized tokenFeeRoute')
        }

        for (const step of this.tokenFeeRoutes[token].steps) {
            amount = getAmountOut(amount, step.ri, step.ro)
        }
        return amount
    }

    stepFee(token) {
        return this._bnbToToken(token, ethers.utils.parseEther('0.0005'))
    }

    async _loadTokenFeeRoute(token) {
        if ([this.config.chain.tokens.NATIVE, this.config.chain.tokens.WRAPPED].includes(token)) {
            return
        }

        if (this.tokenFeeRoutes == null) {
            this.tokenFeeRoutes = {}
        }
        if (this.tokenFeeRoutes[token] != null) {
            return this.tokenFeeRoutes[token]
        }

        const routes = await fetch(`${this.config.route.api}/${this.config.chain.tokens.WRAPPED}/${token}`).then(res => res.json())
        const route = routes[0]
        this.tokenFeeRoutes[token] = {
            liquidity: bn(route.liquidity),
            steps: route.route.map(step => ({
                ri: bn(step.ri),
                ro: bn(step.ro),
            })),
        }
    }

    resolveRouterName(router) {
        return _.findKey(this.AMMS, { router: ga(router) })
    }

    resolveRouterAddress(factory) {
        return _.find(this.AMMS, { factory: ga(factory) })?.router
    }

    async loadTokens() {
        if (this.TOKENS != null && this.LPS != null) {
            return
        }
        [this.TOKENS, this.LPS] = await Promise.all([
            this.config.chain.loadTokens(),
            this.config.chain.loadLiquidityTokens(),
        ])
    }

    _resolveLPSymbol(address) {
        if (this.LPS == null) {
            throw new Error('LPS uninitialized: please call SwapEngine.loadTokens() first')
        }
        const lp = this.LPS[address]
        if (lp == null) {
            return null
        }
        return `${this.resolveTokenSymbol(lp[0])}-${this.resolveTokenSymbol(lp[1])}`
    }

    resolveTokenSymbol(address) {
        if (this.TOKENS == null) {
            throw new Error('TOKENS uninitialized: please call SwapEngine.loadTokens() first')
        }
        address = ga(address)
        return this.TOKENS[address]?.symbol ?? this._resolveLPSymbol(address) ?? address
    }

    resolveTokenAddress(name) {
        if (this.TOKENS == null) {
            throw new Error('TOKENS uninitialized: please call SwapEngine.loadTokens() first')
        }
        return _.findKey(this.TOKENS, v => v.symbol == name.toUpperCase()) ?? name
    }
}

class SwapContext {
    constructor(engine, context) {
        this.engine = engine
        this.sender = context.sender ?? engine.config.chain.provider?.getSigner()?.address ?? BSC_TOKEN_HUB
        this.recipient = context.recipient ?? this.sender
        this.referrer = context.referrer ?? ZERO_ADDRESS
        this.slippage = context.slippage ?? (0.5 / 100)
        this.expiration = context.expiration ?? 20*60*1000
        this.gasLimitRate = context.gasLimitRate ?? 1.5
    }

    async checkBalanceAndAllowance(amountIn) {
        const { sender, engine } = this
        const { tokenIn } = engine.pair
        if (tokenIn == engine.config.chain.tokens.NATIVE) {
            const balance = await engine.config.chain.provider.getBalance(this.sender, 'pending')
            if (balance.lt(amountIn)) {
                await engine.loadTokens()
                return `sender (${this.sender}) has not enough input token ${engine.resolveTokenSymbol(tokenIn)}: ${ethers.utils.formatEther(balance)} < ${ethers.utils.formatEther(amountIn)}`
            }
            return
        }
        const cti = new ethers.Contract(tokenIn, abiIERC20, engine.config.chain.provider)
        const allowance = await cti.allowance(sender, engine.config.verifier.address)
        await engine.loadTokens()
        if (allowance.lt(amountIn)) {
            return `contract (${engine.config.verifier.address}) is not approved to spend ${engine.resolveTokenSymbol(tokenIn)} from sender (${this.sender})`
        }
        const balance = await cti.balanceOf(sender)
        if (balance.lt(amountIn)) {
            return `sender (${sender}) has not enough input token ${engine.resolveTokenSymbol(tokenIn)}: ${ethers.utils.formatEther(balance)} < ${ethers.utils.formatEther(amountIn)}`
        }
    }

    async search(amountIn, disableVerifier = false) {
        const { engine } = this
        let ROUTES = engine.pair.routes

        let firstErr
        for (let i = 0; i < ROUTES.length; ++i) {
            const { routes, dists, simulation } = await engine._searchWithoutVerify(amountIn, ROUTES)
            const { amountOut, gasUsed, err, params } = disableVerifier ?
                simulation :
                await this._verify(amountIn, routes, dists, simulation)

            if (err != null) {
                if (firstErr == null) {
                    firstErr = err
                }
                const reason = err?.error?.body ?? err?.reason ?? err
                if (reason?.startsWith('0x') && reason?.substr(42, 2) == ': ') {
                    const errPair = ga(reason.substr(0, 42))
                    console.error('REMOVE BAD PAIR', errPair)
                    ROUTES = ROUTES.filter(r => !r.steps.some(s => s.a == errPair))
                    continue  // try again
                }
            }
            return { amountOut, gasUsed, err, params, routes, dists }
        }
        return { err: firstErr }
    }

    async aggregate(tokenIn, tokenOut, amountIn, routes, simulation) {
        const { engine, sender, recipient, referrer, gasLimitRate, expiration, slippage } = this
        const value = tokenIn == engine.config.chain.tokens.NATIVE ? amountIn : 0
        const gasLimit = engine.config.chain.callGasLimit

        const order = {
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin: 1,
            deadline: Math.floor(new Date().getTime() / 1000) + expiration,
        }

        const params = [
            order,
            routes,
            recipient,
            referrer,
            { from: sender, gasLimit, value }
        ]

        try {
            let { amountOut, gasUsed } = await engine.config.verifier.verify(this, simulation, ...params)
            order.amountOutMin = amountOut.mul(1000000 * (1-slippage)).div(1000000)
            params[params.length-1].gasLimit = Math.floor(gasUsed * gasLimitRate)
            return { amountOut, gasUsed, params }
        } catch (err) {
            console.error(err, params)
            // routes.map(r => _printRoute(r))
            return { amountOut: bn(-1), gasUsed: bn(-1), err, params }
        }
    }

    async _verify(amountIn, routes, dists, simulation) {
        const { engine, recipient } = this
        const { tokenIn, tokenOut } = engine.pair
        const routesParam = engine._routesToParams(amountIn, tokenOut, recipient, routes, dists)
        const { amountOut, gasUsed, err, params } = await this.aggregate(tokenIn, tokenOut, amountIn, routesParam, simulation)
        return { amountOut, gasUsed, err, params }
    }
}

const DIST_DECIMALS = 1000000

function amountsToDists(amountOuts) {
    const total = amountOuts.reduce((total, a) => total.add(a), bn(0))
    const dists = amountOuts.map(a => a.mul(DIST_DECIMALS).div(total).toNumber() / DIST_DECIMALS)
    return dists
}

function normalize(dists) {
    const total = dists.reduce((total, dist) => total + dist, 0)
    const normalized = []
    for (const dist of dists) {
        normalized.push(dist / total)
    }
    return normalized
}

function distsToAmounts(dists, amountIn) {
    const amounts = []
    let totalAmount = bn(0)
    for (const dist of normalize(dists)) {
        let amount = amountIn.mul(Math.round(DIST_DECIMALS * dist)).div(DIST_DECIMALS)
        if (totalAmount.add(amount).gt(amountIn)) {
            amount = amountIn.sub(totalAmount)
        }
        if (amount.lte(0)) {
            amounts.push(bn(0))
            continue
        }
        totalAmount = totalAmount.add(amount)
        amounts.push(amount)
    }
    if (totalAmount.lt(amountIn)) {
        const remain = amountIn.sub(totalAmount)
        for (let i = 0; i < amounts.length; ++i) {
            if (amounts[i].gt(0)) {
                amounts[i] = amounts[i].add(remain)
                break
            }
        }
    }
    return amounts
}

function applyDistsToRoutes(routes, dists, amountIn) {
    const amounts = distsToAmounts(dists, amountIn)
    return routes.map(({ steps }, i) => ({
        amount: amounts[i],
        steps,
    }))
}

module.exports = {
    SwapContext,
    SwapEngine,
}
