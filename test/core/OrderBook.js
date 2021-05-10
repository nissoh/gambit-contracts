const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed, newWallet, gasUsed } = require("../shared/utilities")
const { toChainlinkPrice } = require("../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../shared/units")
const { initVault, getBnbConfig, getBtcConfig, getDaiConfig } = require("./Vault/helpers")

use(solidity)

const BTC_PRICE = 60000;
const BNB_PRICE = 300;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("OrderBook", function () {
    const provider = waffle.provider
    const [wallet, user0, user1, user2, user3] = provider.getWallets()

    let orderBook;
    let defaults;

    beforeEach(async () => {
        bnb = await deployContract("Token", [])
        bnbPriceFeed = await deployContract("PriceFeed", [])

        btc = await deployContract("Token", [])
        btcPriceFeed = await deployContract("PriceFeed", [])

        eth = await deployContract("Token", [])
        ethPriceFeed = await deployContract("PriceFeed", [])

        dai = await deployContract("Token", [])
        daiPriceFeed = await deployContract("PriceFeed", [])

        busd = await deployContract("Token", [])
        busdPriceFeed = await deployContract("PriceFeed", [])

        vault = await deployContract("Vault", [])
        usdg = await deployContract("USDG", [vault.address])
        router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
        vaultPriceFeed = await deployContract("VaultPriceFeed", [])

        await initVault(vault, router, usdg, vaultPriceFeed)

        distributor0 = await deployContract("TimeDistributor", [])
        yieldTracker0 = await deployContract("YieldTracker", [usdg.address])

        await yieldTracker0.setDistributor(distributor0.address)
        await distributor0.setDistribution([yieldTracker0.address], [1000], [bnb.address])

        await bnb.mint(distributor0.address, 5000)
        await usdg.setYieldTrackers([yieldTracker0.address])

        reader = await deployContract("Reader", [])

        await vaultPriceFeed.setTokenConfig(bnb.address, bnbPriceFeed.address, 8, false)
        await vaultPriceFeed.setTokenConfig(btc.address, btcPriceFeed.address, 8, false)
        await vaultPriceFeed.setTokenConfig(eth.address, ethPriceFeed.address, 8, false)
        await vaultPriceFeed.setTokenConfig(dai.address, daiPriceFeed.address, 8, false)
        await vaultPriceFeed.setPriceSampleSpace(1);

        await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
        await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

        await btcPriceFeed.setLatestAnswer(toChainlinkPrice(BTC_PRICE))
        await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

        await bnbPriceFeed.setLatestAnswer(toChainlinkPrice(BNB_PRICE))
        await vault.setTokenConfig(...getBnbConfig(bnb, bnbPriceFeed))

        await vault.setIsMintingEnabled(true)

        orderBook = await deployContract("OrderBook", [])
        const minExecutionFee = 500000;
        await orderBook.initialize(
            router.address,
            vault.address,
            bnb.address,
            usdg.address,
            minExecutionFee, 
            expandDecimals(5, 30) // minPurchseTokenAmountUsd
        );

        await router.addPlugin(orderBook.address);
        await router.connect(user0).approvePlugin(orderBook.address);

        await btc.mint(user0.address, expandDecimals(100, 8))
        await btc.connect(user0).approve(router.address, expandDecimals(100, 8))

        await dai.mint(user0.address, expandDecimals(1000000, 18))
        await dai.connect(user0).approve(router.address, expandDecimals(1000000, 18))

        await dai.mint(user0.address, expandDecimals(2000000, 18))
        await dai.connect(user0).transfer(vault.address, expandDecimals(2000000, 18))
        await vault.directPoolDeposit(dai.address);

        await btc.mint(user0.address, expandDecimals(100, 8))
        await btc.connect(user0).transfer(vault.address, expandDecimals(100, 8))
        await vault.directPoolDeposit(btc.address);

        defaults = {
            path: [btc.address],
            sizeDelta: toUsd(100000),
            amountIn: expandDecimals(1, 8),
            triggerPrice: toUsd(53000),
            triggerAboveThreshold: true,
            executionFee: expandDecimals(1, 9).mul(1500000),
            collateralToken: btc.address,
            collateralDelta: toUsd(BTC_PRICE),
            user: user0,
            isLong: true
        };
    })

    function positionWrapper(position) {
        return {
            size: position[0],
            collateral: position[1],
            averagePrice: position[2],
            entryFundingRate: position[3],
            reserveAmount: position[4]
        };
    }

    function getDefault(obj, name, defaultValue) {
        return (name in obj) ? obj[name] : defaultValue;
    }

    function defaultCreateIncreaseOrder(props = {}) {
        return orderBook.connect(getDefault(props, 'user', defaults.user)).createIncreaseOrder(
            getDefault(props, 'path', defaults.path),
            getDefault(props, 'amountIn', defaults.amountIn),
            getDefault(props, 'indexToken', defaults.path[defaults.path.length - 1]),
            getDefault(props, 'minOut', 0),
            getDefault(props, 'sizeDelta', defaults.sizeDelta),
            getDefault(props, 'collateralToken', defaults.collateralToken), // _collateralToken
            getDefault(props, 'isLong', defaults.isLong),
            getDefault(props, 'triggerPrice', defaults.triggerPrice),
            getDefault(props, 'triggerAboveThreshold', defaults.triggerAboveThreshold),
            getDefault(props, 'executionFee', defaults.executionFee),
            {value: getDefault(props, 'value', props.executionFee || defaults.executionFee)}
        );
    }

    function defaultCreateDecreaseOrder(props = {}) {
        return orderBook.connect(getDefault(props, 'user', defaults.user)).createDecreaseOrder(
            getDefault(props, 'indexToken', defaults.path[defaults.path.length - 1]),
            getDefault(props, 'sizeDelta', defaults.sizeDelta),
            getDefault(props, 'collateralToken', defaults.collateralToken),
            getDefault(props, 'collateralDelta', defaults.collateralDelta),
            getDefault(props, 'isLong', defaults.isLong),
            getDefault(props, 'triggerPrice', defaults.triggerPrice),
            getDefault(props, 'triggerAboveThreshold', defaults.triggerAboveThreshold),
            getDefault(props, 'executionFee', defaults.executionFee),
            {value: getDefault(props, 'value', props.executionFee || defaults.executionFee)}
        );
    }

    async function getTxFees(tx) {
        const receipt = await provider.getTransactionReceipt(tx.hash);
        return tx.gasPrice.mul(receipt.gasUsed);
    }

    async function getCreatedIncreaseOrder(address, orderIndex = 0) {
        const order = await orderBook.increaseOrders(address, orderIndex);
        return order;
    }

    async function getCreatedDecreaseOrder(address, orderIndex = 0) {
        const order = await orderBook.decreaseOrders(address, orderIndex);
        return order;
    }

    it("setGov", async () => {
        await expect(orderBook.connect(user0).setGov(user1.address)).to.be.revertedWith("OrderBook: forbidden")

        expect(await orderBook.gov()).eq(wallet.address)

        await orderBook.setGov(user0.address)
        expect(await orderBook.gov()).eq(user0.address)

        await orderBook.connect(user0).setGov(user1.address)
        expect(await orderBook.gov()).eq(user1.address)
    });

    it("set*", async() => {
        const cases = [
            ['setMinExecutionFee', 600000],
            ['setMinPurchaseTokenAmountUsd', 1]
        ];
        for (const [name, arg] of cases) {
            await expect(orderBook.connect(user1)[name](arg)).to.be.revertedWith("OrderBook: forbidden");
            await expect(orderBook[name](arg));
        }
    })

    it("initialize, already initialized", async () => {
        await expect(orderBook.connect(user1).initialize(
            router.address,
            vault.address,
            bnb.address,
            usdg.address,
            1, 
            expandDecimals(5, 30) // minPurchseTokenAmountUsd
        )).to.be.revertedWith("OrderBook: forbidden");

        await expect(orderBook.initialize(
            router.address,
            vault.address,
            bnb.address,
            usdg.address,
            1, 
            expandDecimals(5, 30) // minPurchseTokenAmountUsd
        )).to.be.revertedWith("OrderBook: already initialized");
    });

    describe("Increase position orders", () => {
        it("createIncreaseOrder, bad input", async () => {
            const badExecutionFee = 100;
            await expect(defaultCreateIncreaseOrder({
                executionFee: badExecutionFee
            })).to.be.revertedWith("OrderBook: insufficient execution fee");

            const goodExecutionFee = expandDecimals(1, 8);
            await expect(defaultCreateIncreaseOrder({
                executionFee: goodExecutionFee,
                value: goodExecutionFee - 1
            })).to.be.revertedWith("OrderBook: incorrect execution fee transferred");

            await expect(defaultCreateIncreaseOrder({
                path: [bnb.address],
                executionFee: goodExecutionFee,
                value: expandDecimals(10, 8).add(goodExecutionFee).sub(1)
            })).to.be.revertedWith("OrderBook: incorrect value transferred");

            await expect(defaultCreateIncreaseOrder({
                path: [dai.address],
                amountIn: expandDecimals(4, 18)
            })).to.be.revertedWith("OrderBook: insufficient collateral");
        });

        it("createIncreaseOrder, pay BNB", async () => {
            const bnbBalanceBefore = await bnb.balanceOf(orderBook.address);
            const amountIn = expandDecimals(30, 18);
            const value = defaults.executionFee.add(amountIn);
            const tx = await defaultCreateIncreaseOrder({
                path: [bnb.address],
                amountIn,
                value
            });
            reportGasUsed(provider, tx, 'createIncreaseOrder gas used');

            const order = await getCreatedIncreaseOrder(user0.address);
            const bnbBalanceAfter = await bnb.balanceOf(orderBook.address);

            const bnbBalanceDiff = bnbBalanceAfter.sub(bnbBalanceBefore);
            expect(bnbBalanceDiff, 'BNB balance').to.be.equal(value);

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.purchaseToken).to.be.equal(bnb.address);
            expect(order.purchaseTokenAmount, 'purchaseTokenAmount').to.be.equal(amountIn);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta, 'sizeDelta').to.be.equal(defaults.sizeDelta);
            expect(order.isLong).to.be.true;
            expect(order.triggerPrice, 'triggerPrice').to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee, 'executionFee').to.be.equal(defaults.executionFee);
        });

        it("createIncreaseOrder, long A, transfer and purchase A", async () => {
            const btcBalanceBefore = await btc.balanceOf(orderBook.address);
            const tx = await defaultCreateIncreaseOrder();
            reportGasUsed(provider, tx, 'createIncreaseOrder gas used');

            const order = await getCreatedIncreaseOrder(user0.address);
            const btcBalanceAfter = await btc.balanceOf(orderBook.address);

            expect(await bnb.balanceOf(orderBook.address), 'BNB balance').to.be.equal(defaults.executionFee);
            expect(btcBalanceAfter.sub(btcBalanceBefore), 'BTC balance').to.be.equal(defaults.amountIn);

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.purchaseToken).to.be.equal(btc.address);
            expect(order.purchaseTokenAmount).to.be.equal(defaults.amountIn);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta).to.be.equal(defaults.sizeDelta);
            expect(order.isLong).to.be.true;
            expect(order.triggerPrice).to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee).to.be.equal(defaults.executionFee);
        });

        it("createIncreaseOrder, long A, transfer A, purchase B", async () => {
            const daiBalanceBefore = await dai.balanceOf(orderBook.address);
            const tx = await defaultCreateIncreaseOrder({
                path: [btc.address, dai.address]
            });
            reportGasUsed(provider, tx, 'createIncreaseOrder gas used');
            const daiBalanceAfter = await dai.balanceOf(orderBook.address);
            const order = await getCreatedIncreaseOrder(defaults.user.address);

            expect(await bnb.balanceOf(orderBook.address), 'BNB balance').to.be.equal(defaults.executionFee);
            // Q: is it ok to compare with gt and compare to *0.98? To consider fees
            expect(daiBalanceAfter.sub(daiBalanceBefore).gt(defaults.amountIn.mul(BTC_PRICE).mul(98).div(100))).to.be.true;

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.purchaseToken, 'purchaseToken').to.be.equal(dai.address);
            expect(order.purchaseTokenAmount, 'purchaseTokenAmount').to.be.above(expandDecimals(BTC_PRICE * 0.99, 18));
            expect(order.indexToken, 'indexToken').to.be.equal(btc.address);
            expect(order.sizeDelta, 'sizeDelta').to.be.equal(defaults.sizeDelta);
            expect(order.isLong, 'isLong').to.be.true;
            expect(order.triggerPrice, 'triggerPrice').to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold, 'triggerAboveThreshold').to.be.true;
            expect(order.executionFee, 'executionFee').to.be.equal(defaults.executionFee);
        });

        it("createIncreaseOrder, short A, transfer B, purchase B", async () => {
            const daiBalanceBefore = await dai.balanceOf(orderBook.address);
            const amountIn = expandDecimals(30000, 18);
            const tx = await defaultCreateIncreaseOrder({
                path: [dai.address],
                amountIn,
                isLong: false,
                triggerAboveThreshold: true
            });
            reportGasUsed(provider, tx, 'createIncreaseOrder gas used');
            const daiBalanceAfter = await dai.balanceOf(orderBook.address);

            const order = await getCreatedIncreaseOrder(defaults.user.address);
            expect(await bnb.balanceOf(orderBook.address)).to.be.equal(defaults.executionFee);
            expect(daiBalanceAfter.sub(daiBalanceBefore), 'DAI balance').to.be.equal(amountIn);

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.purchaseToken).to.be.equal(dai.address);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta).to.be.equal(defaults.sizeDelta);
            expect(order.purchaseTokenAmount).to.be.equal(amountIn);
            expect(order.isLong).to.be.false;
            expect(order.triggerPrice).to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee).to.be.equal(defaults.executionFee);
        });

        it("createIncreaseOrder, short A, transfer A, purchase B", async () => {
            const daiBalanceBefore = await dai.balanceOf(orderBook.address);
            const tx = await defaultCreateIncreaseOrder({
                path: [btc.address, dai.address],
                isLong: false,
                triggerAboveThreshold: true
            });
            reportGasUsed(provider, tx, 'createIncreaseOrder gas used');
            const daiBalanceAfter = await dai.balanceOf(orderBook.address);

            const order = await getCreatedIncreaseOrder(defaults.user.address);

            expect(await bnb.balanceOf(orderBook.address)).to.be.equal(defaults.executionFee);
            // TODO
            // Q: is it ok to compare with gt and compare to *0.98? To consider fees
            expect(daiBalanceAfter.sub(daiBalanceBefore).gt(defaults.amountIn.mul(BTC_PRICE).mul(98).div(100))).to.be.true;

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.purchaseToken).to.be.equal(dai.address);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta).to.be.equal(defaults.sizeDelta);
            expect(order.purchaseTokenAmount).to.be.above(expandDecimals(BTC_PRICE * 0.99, 18));
            expect(order.isLong).to.be.false;
            expect(order.triggerPrice).to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee).to.be.equal(defaults.executionFee);
        });

        it("updateIncreaseOrder", async () => {
            await defaultCreateIncreaseOrder();

            const newSizeDelta = defaults.sizeDelta.add(100);
            const newTriggerPrice = defaults.triggerPrice.add(100);
            const newTriggerAboveThreshold = !defaults.triggerAboveThreshold;

            await expect(orderBook.connect(user1).updateIncreaseOrder(0, newSizeDelta, newTriggerPrice, newTriggerAboveThreshold))
                .to.be.revertedWith("OrderBook: non-existent order");

            const tx = await orderBook.connect(user0).updateIncreaseOrder(0, newSizeDelta, newTriggerPrice, newTriggerAboveThreshold);
            reportGasUsed(provider, tx, 'updateIncreaseOrder gas used');

            order = await getCreatedIncreaseOrder(user0.address);
            expect(order.sizeDelta).to.be.equal(newSizeDelta);
            expect(order.triggerPrice).to.be.equal(newTriggerPrice);
            expect(order.triggerAboveThreshold).to.be.equal(newTriggerAboveThreshold);
        });

        it("cancelOrder", async () => {
            const bnbBalanceBefore = await defaults.user.getBalance();
            const tokenBalanceBefore = await btc.balanceOf(defaults.user.address);
            const tx1 = await defaultCreateIncreaseOrder();
            let txFees = await getTxFees(tx1);

            await expect(orderBook.connect(user1).cancelIncreaseOrder(0)).to.be.revertedWith("OrderBook: non-existent order");

            const tx2 = await orderBook.connect(user0).cancelIncreaseOrder(0);
            reportGasUsed(provider, tx2, 'cancelIncreaseOrder gas used');

            txFees = txFees.add(await getTxFees(tx2));
            const bnbBalanceAfter = await defaults.user.getBalance();
            expect(bnbBalanceAfter, 'Before and after token balance are not equal')
                .to.be.equal(bnbBalanceBefore.sub(txFees));

            const tokenBalanceAfter = await btc.balanceOf(defaults.user.address);
            expect(tokenBalanceAfter, "Before and after token balance are not equal").to.be.equal(tokenBalanceBefore);

            const order = await getCreatedIncreaseOrder(defaults.user.address);
            expect(order.account).to.be.equal(ZERO_ADDRESS);
        });

        it("cancelOrder, pay BNB", async () => {
            const balanceBefore = await defaults.user.getBalance();
            const bnbBalanceBefore = await bnb.balanceOf(orderBook.address);
            const amountIn = expandDecimals(30, 18);
            const value = defaults.executionFee.add(amountIn);
            const tx1 = await defaultCreateIncreaseOrder({
                path: [bnb.address],
                amountIn,
                value
            });
            let txFees = await getTxFees(tx1);

            await expect(orderBook.connect(user1).cancelIncreaseOrder(0)).to.be.revertedWith("OrderBook: non-existent order");

            const tx2 = await orderBook.connect(user0).cancelIncreaseOrder(0);
            reportGasUsed(provider, tx2, 'cancelIncreaseOrder gas used');
            txFees = txFees.add(await getTxFees(tx2));

            const balanceAfter = await defaults.user.getBalance();
            expect(balanceAfter, "Before and after balance are not equal").to.be.equal(balanceBefore.sub(txFees));

            const order = await getCreatedIncreaseOrder(defaults.user.address);
            expect(order.account).to.be.equal(ZERO_ADDRESS);
        });

        it("executeOrder, non-existent order", async () => {
            await expect(orderBook.executeIncreaseOrder(user3.address, 0, user1.address)).to.be.revertedWith("OrderBook: non-existent order");
        });

        it("executeOrder, current price is invalid", async () => {
            let orderIndex = 0;

            await defaultCreateIncreaseOrder({triggerPrice: expandDecimals(BTC_PRICE + 1000, 30)});
            const orderA = await orderBook.increaseOrders(defaults.user.address, orderIndex++);

            await expect(orderBook.executeIncreaseOrder(orderA.account, orderA.index, user1.address))
                .to.be.revertedWith("OrderBook: invalid price for execution");

            await defaultCreateIncreaseOrder({
                // TODO use setLatestAnswer instead
                triggerPrice: expandDecimals(BTC_PRICE + 1000, 30),
                isLong: false,
                triggerAboveThreshold: true
            });
            const orderB = await orderBook.increaseOrders(defaults.user.address, orderIndex++);
            await expect(orderBook.executeIncreaseOrder(orderB.account, orderB.index, user1.address))
                .to.be.revertedWith("OrderBook: invalid price for execution");
        });

        it("executeOrder, long, purchase token same as collateral", async () => {
            await defaultCreateIncreaseOrder();

            const order = await orderBook.increaseOrders(defaults.user.address, 0);

            const executorBalanceBefore = await user1.getBalance();
            const tx = await orderBook.executeIncreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeIncreaseOrder gas used');

            const executorBalanceAfter = await user1.getBalance();
            expect(executorBalanceAfter.gt(executorBalanceBefore)).to.be.true

            const position = positionWrapper(await vault.getPosition(user0.address, btc.address, btc.address, defaults.isLong));
            // TODO is it enough to check?
            expect(position.size).to.be.equal(order.sizeDelta);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("executeOrder, long, swap purchase token to collateral", async () => {
            await defaultCreateIncreaseOrder({
                path: [dai.address],
                amountIn: expandDecimals(50000, 18)
            });

            const order = await orderBook.increaseOrders(defaults.user.address, 0);
            const tx = await orderBook.executeIncreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeIncreaseOrder gas used');

            const position = positionWrapper(await vault.getPosition(user0.address, btc.address, btc.address, defaults.isLong));
            // TODO is it enough to check?
            expect(position.size).to.be.equal(order.sizeDelta);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("executeOrder, short, purchase token same as collateral", async () => {
            dai.mint(user0.address, expandDecimals(50000, 18));
            await defaultCreateIncreaseOrder({
                path: [dai.address],
                collateralToken: dai.address,
                isLong: false,
                amountIn: expandDecimals(50000, 18),
                triggerAboveThreshold: true,
                // TODO use setLatestPrice
                triggerPrice: expandDecimals(BTC_PRICE - 100, 30)
            });

            const order = await orderBook.increaseOrders(defaults.user.address, 0);
            const tx = await orderBook.executeIncreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeIncreaseOrder gas used');

            const position = positionWrapper(await vault.getPosition(user0.address, dai.address, btc.address, false));
            // TODO is it enough to check?
            expect(position.size, 'position.size').to.be.equal(order.sizeDelta);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("executeOrder, short, swap purchase token to collateral", async () => {
            await defaultCreateIncreaseOrder({
                isLong: false,
                collateralToken: dai.address,
                triggerAboveThreshold: true,
                // TODO use setLatestPrice
                triggerPrice: expandDecimals(BTC_PRICE - 100, 30)
            });

            const order = await orderBook.increaseOrders(defaults.user.address, 0);
            const tx = await orderBook.executeIncreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeIncreaseOrder gas used');

            const position = positionWrapper(await vault.getPosition(user0.address, dai.address, btc.address, false));
            // TODO is it enough to check?
            expect(position.size, 'position.size').to.be.equal(order.sizeDelta);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("executeOrder, short, pay BNB, no swap", async () => {
            const amountIn = expandDecimals(50, 18);
            const value = defaults.executionFee.add(amountIn)
            await defaultCreateIncreaseOrder({
                path: [bnb.address],
                amountIn,
                value,
                indexToken: bnb.address,
                collateralToken: dai.address,
                isLong: false,
                triggerboveThreshold: true,
                // TODO use setLatestPrice
                triggerPrice: expandDecimals(BNB_PRICE - 10, 30)
            });

            const order = await orderBook.increaseOrders(defaults.user.address, 0);
            const tx = await orderBook.executeIncreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeIncreaseOrder gas used');

            const position = positionWrapper(await vault.getPosition(user0.address, dai.address, bnb.address, false));
            // TODO is it enough to check?
            expect(position.size, 'position.size').to.be.equal(order.sizeDelta);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("createIncreaseOrder, bad path", async () => {
            await expect(defaultCreateIncreaseOrder({
                path: [btc.address, btc.address]
            })).to.be.revertedWith("OrderBook: invalid _path");
        });

    });

    describe("Decrease position orders", () => {
        it("Create decrease order, long", async () => {
            const tx = await defaultCreateDecreaseOrder();
            reportGasUsed(provider, tx, 'createDecraseOrder gas used');
            let order = await getCreatedDecreaseOrder(user0.address);
            const btcBalanceAfter = await btc.balanceOf(orderBook.address);

            expect(await bnb.balanceOf(orderBook.address), 'BNB balance').to.be.equal(defaults.executionFee);

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta).to.be.equal(defaults.sizeDelta);
            expect(order.collateralToken).to.be.equal(defaults.collateralToken);
            expect(order.collateralDelta).to.be.equal(defaults.collateralDelta);
            expect(order.isLong).to.be.true;
            expect(order.triggerPrice).to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee).to.be.equal(defaults.executionFee);
        });

        it("updateDecreaseOrder", async () => {
            await defaultCreateDecreaseOrder();

            const newSizeDelta = defaults.sizeDelta.add(100);
            const newTriggerPrice = defaults.triggerPrice.add(100);
            const newTriggerAboveThreshold = !defaults.triggerAboveThreshold;
            const newCollateralDelta = defaults.collateralDelta.add(100);

            await expect(orderBook.connect(user1).updateDecreaseOrder(
                0, newCollateralDelta, newSizeDelta, newTriggerPrice, newTriggerAboveThreshold
            )).to.be.revertedWith("OrderBook: non-existent order");

            const tx2 = await orderBook.connect(user0).updateDecreaseOrder(
                0, newCollateralDelta, newSizeDelta, newTriggerPrice, newTriggerAboveThreshold
            );
            reportGasUsed(provider, tx2, 'updateDecreaseOrder gas used');

            order = await getCreatedDecreaseOrder(user0.address);
            expect(order.sizeDelta).to.be.equal(newSizeDelta);
            expect(order.collateralDelta).to.be.equal(newCollateralDelta);
            expect(order.triggerPrice).to.be.equal(newTriggerPrice);
            expect(order.triggerAboveThreshold).to.be.equal(newTriggerAboveThreshold);
        });

        it("Create decrease order, short", async () => {
            const tx = await defaultCreateDecreaseOrder({
                isLong: false
            });
            reportGasUsed(provider, tx, 'createDecreaseOrder gas used');
            const order = await getCreatedDecreaseOrder(user0.address);
            const btcBalanceAfter = await btc.balanceOf(orderBook.address);

            expect(await bnb.balanceOf(orderBook.address), 'BNB balance').to.be.equal(defaults.executionFee);

            expect(order.account).to.be.equal(defaults.user.address);
            expect(order.indexToken).to.be.equal(btc.address);
            expect(order.sizeDelta).to.be.equal(defaults.sizeDelta);
            expect(order.collateralToken).to.be.equal(defaults.collateralToken);
            expect(order.collateralDelta).to.be.equal(defaults.collateralDelta);
            expect(order.isLong).to.be.false;
            expect(order.triggerPrice).to.be.equal(defaults.triggerPrice);
            expect(order.triggerAboveThreshold).to.be.true;
            expect(order.executionFee).to.be.equal(defaults.executionFee);
        });

        it("Execute decrease order, long", async () => {
            await btc.connect(user0).transfer(vault.address, expandDecimals(10000, 8).div(BTC_PRICE));
            await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(20000), true);

            const btcBalanceBefore = await btc.balanceOf(user0.address);
            let position = positionWrapper(await vault.getPosition(user0.address, btc.address, btc.address, true));

            await defaultCreateDecreaseOrder({
                collateralDelta: position.collateral,
                sizeDelta: position.size,
                triggerAboveThreshold: true,
                triggerPrice: toUsd(BTC_PRICE + 5000),
                isLong: true
            });

            const order = await orderBook.decreaseOrders(defaults.user.address, 0);

            await btcPriceFeed.setLatestAnswer(toChainlinkPrice(BTC_PRICE + 5050));

            const executorBalanceBefore = await user1.getBalance();
            const tx = await orderBook.executeDecreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeDecreaseOrder gas used');

            const executorBalanceAfter = await user1.getBalance();
            expect(executorBalanceAfter).to.be.equal(executorBalanceBefore.add(defaults.executionFee));

            const btcBalanceAfter = await btc.balanceOf(user0.address);
            expect(btcBalanceAfter.sub(btcBalanceBefore)).to.be.equal("17899051");

            position = positionWrapper(await vault.getPosition(user0.address, btc.address, btc.address, defaults.isLong));

            expect(position.size).to.be.equal(0);
            expect(position.collateral).to.be.equal(0);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        it("Execute decrease order, short", async () => {
            await dai.connect(user0).transfer(vault.address, expandDecimals(10000, 18));
            await vault.connect(user0).increasePosition(user0.address, dai.address, btc.address, toUsd(20000), false);

            let position = positionWrapper(await vault.getPosition(user0.address, dai.address, btc.address, false));
            const daiBalanceBefore = await dai.balanceOf(user0.address);

            await defaultCreateDecreaseOrder({
                collateralDelta: position.collateral,
                collateralToken: dai.address,
                sizeDelta: position.size,
                triggerAboveThreshold: false,
                triggerPrice: toUsd(BTC_PRICE - 1000),
                isLong: false
            });

            const order = await orderBook.decreaseOrders(defaults.user.address, 0);

            await btcPriceFeed.setLatestAnswer(toChainlinkPrice(BTC_PRICE - 1500));

            const executorBalanceBefore = await user1.getBalance();
            const tx = await orderBook.executeDecreaseOrder(defaults.user.address, 0, user1.address);
            reportGasUsed(provider, tx, 'executeDecreaseOrder gas used');

            const executorBalanceAfter = await user1.getBalance();
            expect(executorBalanceAfter.gt(executorBalanceBefore)).to.be.true

            const daiBalanceAfter = await dai.balanceOf(user0.address);
            expect(daiBalanceAfter.sub(daiBalanceBefore)).to.be.equal("10460000000000000000000");

            position = positionWrapper(await vault.getPosition(user0.address, btc.address, btc.address, defaults.isLong));

            expect(position.size).to.be.equal(0);
            expect(position.collateral).to.be.equal(0);

            const orderAfter = await orderBook.increaseOrders(defaults.user.address, 0);
            expect(orderAfter.account).to.be.equal(ZERO_ADDRESS);
        });

        // TODO executeDecreaseOrder if collateralToken == weth

        it("Cancel decrease order", async () => {
            await defaultCreateDecreaseOrder();
            let order = await getCreatedDecreaseOrder(user0.address);
            expect(order.account).to.not.be.equal(ZERO_ADDRESS);

            const tx = await orderBook.connect(user0).cancelDecreaseOrder(0);
            reportGasUsed(provider, tx, 'cancelDecreaseOrder gas used');
            order = await getCreatedDecreaseOrder(user0.address);
            expect(order.account).to.be.equal(ZERO_ADDRESS);
        });
    })
;
});








