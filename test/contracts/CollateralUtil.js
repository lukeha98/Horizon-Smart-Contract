'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { toUnit, currentTime } = require('../utils')();

const { setupAllContracts, setupContract, mockToken } = require('./setup');

const { ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

let CollateralState;

contract('CollateralUtil', async accounts => {
	const sUSD = toBytes32('zUSD');
	const sETH = toBytes32('zBNB');
	const sBTC = toBytes32('zBTC');

	const oneRenBTC = web3.utils.toBN('100000000');
	const oneThousandsUSD = toUnit(1000);
	const fiveThousandsUSD = toUnit(5000);

	let tx;
	let loan;
	let id;

	const name = 'Some name';
	const symbol = 'TOKEN';

	const [deployerAccount, owner, oracle, , account1] = accounts;

	let cerc20,
		state,
		managerState,
		feePool,
		exchangeRates,
		addressResolver,
		sUSDSynth,
		sBTCSynth,
		renBTC,
		synths,
		manager,
		issuer,
		util,
		debtCache;

	const getid = tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issuesUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of synths to deposit.
		await sUSDSynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuesBTCtoAccount = async (issueAmount, receiver) => {
		await sBTCSynth.issue(receiver, issueAmount, { from: owner });
	};

	const issueRenBTCtoAccount = async (issueAmount, receiver) => {
		await renBTC.transfer(receiver, issueAmount, { from: owner });
	};

	const updateRatesWithDefaults = async () => {
		const timestamp = await currentTime();

		await exchangeRates.updateRates([sETH], ['100'].map(toUnit), timestamp, {
			from: oracle,
		});

		const sBTC = toBytes32('zBTC');

		await exchangeRates.updateRates([sBTC], ['10000'].map(toUnit), timestamp, {
			from: oracle,
		});
	};

	const deployCollateral = async ({
		state,
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
		underCon,
		decimals,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralErc20',
			args: [state, owner, manager, resolver, collatKey, minColat, minSize, underCon, decimals],
		});
	};

	const setupMultiCollateral = async () => {
		synths = ['zUSD', 'zBTC'];
		({
			ExchangeRates: exchangeRates,
			ZassetzUSD: sUSDSynth,
			ZassetzBTC: sBTCSynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			CollateralUtil: util,
			DebtCache: debtCache,
			CollateralManager: manager,
			CollateralManagerState: managerState,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'Synthetix',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
				'Exchanger',
				'CollateralUtil',
				'CollateralManager',
				'CollateralManagerState',
			],
		}));

		await managerState.setAssociatedContract(manager.address, { from: owner });

		state = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		({ token: renBTC } = await mockToken({
			accounts,
			name,
			symbol,
			supply: 1e6,
		}));

		cerc20 = await deployCollateral({
			state: state.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: sBTC,
			minColat: toUnit(1.5),
			minSize: toUnit(0.1),
			underCon: renBTC.address,
			decimals: 8,
		});

		await state.setAssociatedContract(cerc20.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralErc20'), toBytes32('CollateralManager')],
			[cerc20.address, manager.address],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([cerc20.address], { from: owner });

		await cerc20.addSynths(
			['ZassetzUSD', 'ZassetzBTC'].map(toBytes32),
			['zUSD', 'zBTC'].map(toBytes32),
			{ from: owner }
		);

		await manager.addSynths(
			['ZassetzUSD', 'ZassetzBTC'].map(toBytes32),
			['zUSD', 'zBTC'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the synths we need.
		await manager.rebuildCache();

		// Issue ren and set allowance
		await issueRenBTCtoAccount(100 * 1e8, account1);
		await renBTC.approve(cerc20.address, 100 * 1e8, { from: account1 });
	};

	before(async () => {
		CollateralState = artifacts.require(`CollateralState`);

		await setupMultiCollateral();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issuesUSDToAccount(toUnit(1000), owner);
		await issuesBTCtoAccount(toUnit(10), owner);

		await debtCache.takeDebtSnapshot();
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: util.abi,
			ignoreParents: ['MixinResolver'],
			expected: [],
		});
	});

	describe('liquidation amount test', async () => {
		let amountToLiquidate;
		let minCratio;
		let collateralKey;

		/**
		 * r = target issuance ratio
		 * D = debt balance in sUSD
		 * V = Collateral VALUE in sUSD
		 * P = liquidation penalty
		 * Calculates amount of sUSD = (D - V * r) / (1 - (1 + P) * r)
		 *
		 * To go back to another synth, remember to do effective value
		 */

		beforeEach(async () => {
			tx = await cerc20.open(oneRenBTC, fiveThousandsUSD, sUSD, {
				from: account1,
			});

			id = getid(tx);
			loan = await state.getLoan(account1, id);
			minCratio = await cerc20.minCratio();
			collateralKey = await cerc20.collateralKey();
		});

		it('when we start at 200%, we can take a 25% reduction in collateral prices', async () => {
			await exchangeRates.updateRates([sBTC], ['7500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await util.liquidationAmount(loan, minCratio, collateralKey);

			assert.bnEqual(amountToLiquidate, toUnit(0));
		});

		it('when we start at 200%, a price shock of 30% in the collateral requires 25% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await util.liquidationAmount(loan, minCratio, collateralKey);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');
		});

		it('when we start at 200%, a price shock of 40% in the collateral requires 75% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['6000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await util.liquidationAmount(loan, minCratio, collateralKey);

			assert.bnClose(amountToLiquidate, toUnit(3750), '10000');
		});

		it('when we start at 200%, a price shock of 45% in the collateral requires 100% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['5500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await util.liquidationAmount(loan, minCratio, collateralKey);

			assert.bnClose(amountToLiquidate, toUnit(5000), '10000');
		});
	});

	describe('collateral redeemed test', async () => {
		let collateralRedeemed;
		let collateralKey;

		beforeEach(async () => {
			collateralKey = await cerc20.collateralKey();
		});

		it('when BTC is @ $10000 and we are liquidating 1000 sUSD, then redeem 0.11 BTC', async () => {
			collateralRedeemed = await util.collateralRedeemed(sUSD, oneThousandsUSD, collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(0.11));
		});

		it('when BTC is @ $20000 and we are liquidating 1000 sUSD, then redeem 0.055 BTC', async () => {
			await exchangeRates.updateRates([sBTC], ['20000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await util.collateralRedeemed(sUSD, oneThousandsUSD, collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(0.055));
		});

		it('when BTC is @ $7000 and we are liquidating 2500 sUSD, then redeem 0.36666 ETH', async () => {
			await exchangeRates.updateRates([sBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await util.collateralRedeemed(sUSD, toUnit(2500), collateralKey);

			assert.bnClose(collateralRedeemed, toUnit(0.392857142857142857), '100');
		});

		it('regardless of BTC price, we liquidate 1.1 * amount when doing sETH', async () => {
			collateralRedeemed = await util.collateralRedeemed(sBTC, toUnit(1), collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));

			await exchangeRates.updateRates([sBTC], ['1000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await util.collateralRedeemed(sBTC, toUnit(1), collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));
		});
	});
});
