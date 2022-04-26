
const tokenDirection = (ai, ao) => ai.localeCompare(ao, undefined, {sensitivity: 'base'}) < 0

const getAmountOut = (amountIn, ri, ro, fee10000 = 0) => {
    const amountInWithFee = amountIn.mul(10000 - fee10000);
    const numerator = amountInWithFee.mul(ro);
    const denominator = ri.mul(10000).add(amountInWithFee);
    return numerator.div(denominator);
}

module.exports = {
    tokenDirection,
    getAmountOut,
}
