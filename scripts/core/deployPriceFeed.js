const { deployContract, contractAt , sendTxn } = require("../shared/helpers")
const { expandDecimals } = require("../../test/shared/utilities")
const { toUsd } = require("../../test/shared/units")

async function main() {
  const nativeToken = { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" }
  const secondaryPriceFeed = { address: "0xDA7a001b254CD22e46d3eAB04d937489c93174C3" }
  const vaultPriceFeed = await deployContract("VaultPriceFeed", [])

  const btc = { address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c" }
  const eth = { address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8" }
  const bnb = nativeToken
  const bnbBusd = { address: "0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16" }
  const ethBnb = { address: "0x74E4716E431f45807DCF19f284c7aA99F18a4fbc" }
  const btcBnb = { address: "0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082" }

  await sendTxn(vaultPriceFeed.setTokens(btc.address, eth.address, bnb.address), "vaultPriceFeed.setTokens")
  await sendTxn(vaultPriceFeed.setPairs(bnbBusd.address, ethBnb.address, btcBnb.address), "vaultPriceFeed.setPairs")

  await sendTxn(vaultPriceFeed.setMaxStrictPriceDeviation(expandDecimals(5, 28)), "vaultPriceFeed.setMaxStrictPriceDeviation") // 0.05 USD
  await sendTxn(vaultPriceFeed.setPriceSampleSpace(1), "vaultPriceFeed.setPriceSampleSpace")

  await sendTxn(vaultPriceFeed.setSecondaryPriceFeed(secondaryPriceFeed.address), "vaultPriceFeed.setSecondaryPriceFeed")
  await sendTxn(vaultPriceFeed.setIsSecondaryPriceEnabled(false), "vaultPriceFeed.isSecondaryPriceEnabled")
  await sendTxn(vaultPriceFeed.setUseV2Pricing(true), "vaultPriceFeed.useV2Pricing")
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
