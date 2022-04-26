const _ = require('lodash')
const { ethers } = require('ethers');
const { SwapEngine } = require('..')
const abiBroker = require('../abi/Broker.abi.json')

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

const args = process.argv.slice(2)

const tokenIn = args[0]
const tokenOut = args[1]
const amountIn = ethers.utils.parseEther(args[2])
const sender = args[3]
const recipient = args[4]
const referrer = args[5]

const engine = new SwapEngine({
    // sample verfier for Broker
    // verifier: {
    //     address: '0x45f19b5aba58d83cf09923b7c861be19bde752a1',
    //     abi: abiBroker,
    //     verify: async (context, simulation, order, routes, recipient, referrer, opts) => {
    //         // const contract = context.engine.contract
    //         // const { amountOut, gasUsed } = simulation
    //         return simulation // skip verifcation, use simulated data instead
    //         const signedOrder = {
    //             ...order,
    //             // add order signature here
    //             r: ZERO_HASH,
    //             v: ZERO_HASH,
    //             s: ZERO_HASH,
    //         }
    //         opts = _.clone(opts)
    //         const gasLimit = await contract.estimateGas.fill(signedOrder, routes, referrer, ZERO_HASH, opts)
    //         opts.gasLimit = gasLimit.add(gasLimit.div(2))
    //         const profit = await contract.callStatic.fill(signedOrder, routes, referrer, ZERO_HASH, opts)
    //         return {
    //             amountOut: profit.add(order.amountOutMin),
    //             gasUsed: gasLimit,
    //         }
    //     },
    // },
    chain: {
        provider: new ethers.providers.JsonRpcProvider('https://rpc.lz.finance/bsc'),
    },
    // debug: true,
})

async function swap(tokenIn, tokenOut, amountIn, context) {
    context = engine.createSwapContext(context)

    console.log('loading pair...')
    let t = new Date().getTime()
    await engine.loadPair(tokenIn, tokenOut)
    console.log(`   ${new Date().getTime()-t} ms`)
    t = new Date().getTime()

    // console.log('checking balance and allowance...')
    // const err = await context.checkBalanceAndAllowance(amountIn)
    // if (err != null) {
    //     console.error('Disable VERIFIER: ', err)
    //     var disableVerifier = true
    //     // throw new Error(err)
    // }
    // console.log(`   ${new Date().getTime()-t} ms`)
    // t = new Date().getTime()

    // engine.updateLiquidityReserves({
    //     '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc': {
    //         r0: ethers.utils.parseEther('123'),
    //         r1: ethers.utils.parseEther('456'),
    //     },
    //     // more reserves here..
    // })

    console.log('searching for best route...')
    const res = await context.search(amountIn, false)

    console.log(res)
    console.log(`   ${new Date().getTime()-t} ms`)
    t = new Date().getTime()

    // res.params is ready for contract call
    // const actual = await engine.aggregator.callStatic.aggregate(...res.params)
    // console.log(ethers.utils.formatEther(actual.amountOut))
    return [res]
}

swap(tokenIn, tokenOut, amountIn, {sender, recipient, referrer})
    // .then(candidates => candidates.forEach(value => console.log(value)))
    .then(async res => {
        // make sure the tokens is load for output format
        await engine.loadTokens()
        return res
    })
    .then(candidates => candidates.map(candidate => _printCandidate(candidate)))
    .catch(console.error)

function _printRoute(route) {
    console.log('+++ route', {
        amount: ethers.utils.formatEther(route.amount),
        entry: engine.resolveTokenSymbol(route.steps[0][2]),
    })
    route.steps.map(step => {
        const path = []
        for (let i = 1; i < step.length - 1; i += 1) {
            path.push(step[i])
        }
        console.log('step', {
            router: engine.resolveRouterName(step[0]),
            path: path.map(engine.resolveTokenSymbol.bind(engine)),
            exit: engine.resolveTokenSymbol(step[step.length - 1]),
        })
    })
}

function _printCandidate(candidate) {
    if (candidate.err) {
        console.error('===>', candidate.err?.error?.body ?? candidate.err?.reason ?? candidate.err)
    } else {
        console.log('====== candidate', candidate.n > 1 ? candidate.n : '', {
            amountOut: ethers.utils.formatEther(candidate.amountOut),
            gasUsed: candidate.gasUsed,
            // params: candidate.params,
        })
    }
    // const routes = candidate?.params[1]
    // console.log('=>', candidate.amountOut.toString(), candidate.n ? `:${n}` : '')
    // routes?.forEach(route => _printRoute(route))
}
