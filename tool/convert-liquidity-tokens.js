const _ = require('lodash');
const fetch = require('node-fetch')
const { ethers } = require('ethers');
const ga = ethers.utils.getAddress

fetch('https://farm.army/api/v0/liquidity-tokens')
    .then(r => r.json())
    .then(lps => {
        return lps.map(lp => [ga(lp.address), [ga(lp.tokens[0].address), ga(lp.tokens[1].address)]])
    })
    .then(_.fromPairs.bind(_))
    .then(lps => JSON.stringify(lps, undefined, 2))
    .then(console.log)
    .catch(console.error)
