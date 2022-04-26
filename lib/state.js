const _ = require('lodash')
const { ethers } = require('ethers');
const bn = ethers.BigNumber.from
const { tokenDirection, getAmountOut } = require('./utils')

class StateEngine {
    constructor(db) {
        this.db = db ?? {}
    }

    updateDB(steps, amms, rs) {
        steps.forEach(({ a, ai, ao, ri, ro, c }) => {
            const forward = tokenDirection(ai, ao)
            const [t0, t1, r0, r1] = forward ? [ai, ao, ri, ro] : [ao, ai, ro, ri]
            const fee10000 = Object.values(amms).find(amm => amm.factory == c)?.fee10000
            this.db[a] = { t0, t1, r0, r1, fee10000 }
        })
        const rr = Object.entries(rs ?? {})
        if (rr.length > 0) {
            rr.forEach(([a, r]) => {
                if (this.db[a] == null) {
                    console.warn('WARN: unknown liquidity', a)
                }
                this.db[a] = _.merge(this.db[a], r)
            })
        }
        return this
    }

    snapshot() { return _.cloneDeep(db) }
    revert(db) { this.db = db }

    swapStep(tokenIn, amountIn, a) {
        const pool = this.db[a]
        const { t0, r0, r1, fee10000 } = pool
        const forward = tokenIn == t0
        const [ri, ro] = forward ? [r0, r1] : [r1, r0]
        const amountOut = getAmountOut(amountIn, ri, ro, fee10000)
        if (forward) {
            pool.r0 = pool.r0.add(amountIn)
            pool.r1 = pool.r1.sub(amountOut)
        } else {
            pool.r1 = pool.r1.add(amountIn)
            pool.r0 = pool.r0.sub(amountOut)
        }
        return amountOut
    }

    swapSteps(amountIn, steps) {
        let amountOut = amountIn
        for (const step of steps) {
            amountOut = this.swapStep(step.ai, amountOut, step.a)
        }
        return amountOut
    }

    swap(routes) {
        const amountOuts = []
        let amountOut = bn(0)
        for (const route of routes) {
            if (route.amount?.gt(0)) {
                const amt = this.swapSteps(route.amount, route.steps)
                amountOuts.push(amt)
                amountOut = amountOut.add(amt)
            } else {
                amountOuts.push(bn(0))
            }
        }
        return [amountOut, amountOuts]
    }
}

module.exports = {
    StateEngine,
}