# swap-engine
Swap aggregator engine with smart order routing.

Install
```
yarn
```

Usage:
```
yarn swap tokenIn tokenOut amountIn [sender [recipient [referrer]]]
```

+ token symbols can be used instead of addresses (https://raw.githubusercontent.com/launchzone/configs/main/bsc/tokens.json)
+ `amountIn` float number with 18 decimals

Examples
```
yarn swap BNB LZ 1000
yarn swap 0x4211959585C8F18B06dab8B5bB0Bc825cad4c1De 0x411Ec510c85C9e56271bF4E10364Ffa909E685D9 13.6 0x8710241aedE4b6E11eb3f765CD81aC9A5d62da7b
yarn swap BNB 0x411Ec510c85C9e56271bF4E10364Ffa909E685D9 1000
```
