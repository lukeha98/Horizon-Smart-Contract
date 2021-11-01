'use strict';

const { artifacts, contract, web3 } = require('@nomiclabs/buidler');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const MockExchanger = artifacts.require('MockExchanger');
const Synth = artifacts.require('Synth');

const { setupAllContracts } = require('./setup');

const { currentTime, toUnit, bytesToString } = require('../utils')();
const {
	issueSynthsToUser,
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('Synth', async accounts => {
	const [zUSD, HZN, zEUR] = ['zUSD', 'HZN', 'zEUR'].map(toBytes32);

	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let feePool,
		FEE_ADDRESS,
		synthetix,
		exchangeRates,
		zUSDContract,
		addressResolver,
		systemStatus,
		systemSettings,
		exchanger,
		debtCache,
		issuer;

	before(async () => {
		({
			AddressResolver: addressResolver,
			Synthetix: synthetix,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			SystemStatus: systemStatus,
			Synth: zUSDContract,
			Exchanger: exchanger,
			DebtCache: debtCache,
			Issuer: issuer,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			contracts: [
				'Synth',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // required for Exchanger/FeePool to access the synth exchange fee rates
				'Synthetix',
				'SystemStatus',
				'AddressResolver',
				'DebtCache',
				'Issuer', // required to issue via Synthetix
				'Exchanger', // required to exchange into zUSD when transferring to the FeePool
				'SystemSettings',
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral() to read collateral
			],
		}));

		FEE_ADDRESS = await feePool.FEE_ADDRESS();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		const timestamp = await currentTime();

		// Send a price update to guarantee we're not stale.
		await exchangeRates.updateRates([HZN], ['0.1'].map(toUnit), timestamp, {
			from: oracle,
		});
		await debtCache.takeDebtSnapshot();

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		const synth = await Synth.new(
			account1,
			account2,
			'Zasset XYZ',
			'zXYZ',
			owner,
			toBytes32('zXYZ'),
			web3.utils.toWei('100'),
			addressResolver.address,
			{ from: deployerAccount }
		);

		assert.equal(await synth.proxy(), account1);
		assert.equal(await synth.tokenState(), account2);
		assert.equal(await synth.name(), 'Zasset XYZ');
		assert.equal(await synth.symbol(), 'zXYZ');
		assert.bnEqual(await synth.decimals(), 18);
		assert.equal(await synth.owner(), owner);
		assert.equal(bytesToString(await synth.currencyKey()), 'zXYZ');
		assert.bnEqual(await synth.totalSupply(), toUnit('100'));
		assert.equal(await synth.resolver(), addressResolver.address);
	});

	describe('mutative functions and access', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: zUSDContract.abi,
				ignoreParents: ['ExternStateToken', 'MixinResolver'],
				expected: [
					'issue',
					'burn',
					'setTotalSupply',
					'transfer',
					'transferAndSettle',
					'transferFrom',
					'transferFromAndSettle',
				],
			});
		});

		describe('when non-internal contract tries to issue', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: zUSDContract.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});
		describe('when non-internal tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: zUSDContract.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});
	});

	describe('suspension conditions on transfers', () => {
		const amount = toUnit('10000');
		beforeEach(async () => {
			// ensure owner has funds
			await synthetix.issueSynths(amount, { from: owner });

			// approve for transferFrom to work
			await zUSDContract.approve(account1, amount, { from: owner });
		});

		['System', 'Synth'].forEach(section => {
			describe(`when ${section} is suspended`, () => {
				const synth = toBytes32('zUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section, suspend: true, synth });
				});
				it('when transfer() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						zUSDContract.transfer(account1, amount, {
							from: owner,
						}),
						'Operation prohibited'
					);
				});
				it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						zUSDContract.transferFrom(owner, account1, amount, {
							from: account1,
						}),
						'Operation prohibited'
					);
				});
				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: false, synth });
					});
					it('when transfer() is invoked, it works as expected', async () => {
						await zUSDContract.transfer(account1, amount, {
							from: owner,
						});
					});
					it('when transferFrom() is invoked, it works as expected', async () => {
						await zUSDContract.transferFrom(owner, account1, amount, {
							from: account1,
						});
					});
				});
			});
		});
		describe('when zETH is suspended', () => {
			const synth = toBytes32('zETH');
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
			});
			it('when transfer() is invoked for zUSD, it works as expected', async () => {
				await zUSDContract.transfer(account1, amount, {
					from: owner,
				});
			});
			it('when transferFrom() is invoked for zUSD, it works as expected', async () => {
				await zUSDContract.transferFrom(owner, account1, amount, {
					from: account1,
				});
			});
		});
	});

	it('should transfer (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 zUSD.
		const amount = toUnit('10000');
		await synthetix.issueSynths(amount, { from: owner });

		// Do a single transfer of all our zUSD.
		const transaction = await zUSDContract.transfer(account1, amount, {
			from: owner,
		});

		// Events should be a fee exchange and a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await zUSDContract.balanceOf(account1), amount);
	});

	it('should revert when transferring (ERC20) with insufficient balance', async () => {
		// Issue 10,000 zUSD.
		const amount = toUnit('10000');
		await synthetix.issueSynths(amount, { from: owner });

		// Try to transfer 10,000 + 1 wei, which we don't have the balance for.
		await assert.revert(
			zUSDContract.transfer(account1, amount.add(web3.utils.toBN('1')), { from: owner })
		);
	});

	it('should transferFrom (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 zUSD.
		const amount = toUnit('10000');
		await synthetix.issueSynths(amount, { from: owner });

		// Give account1 permission to act on our behalf
		await zUSDContract.approve(account1, amount, { from: owner });

		// Do a single transfer of all our zUSD.
		const transaction = await zUSDContract.transferFrom(owner, account1, amount, {
			from: account1,
		});

		// Events should be a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await zUSDContract.balanceOf(account1), amount);

		// And allowance should be exhausted
		assert.bnEqual(await zUSDContract.allowance(owner, account1), 0);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient allowance', async () => {
		// Issue 10,000 zUSD.
		const amount = toUnit('10000');
		await synthetix.issueSynths(amount, { from: owner });

		// Approve for 1 wei less than amount
		await zUSDContract.approve(account1, amount.sub(web3.utils.toBN('1')), {
			from: owner,
		});

		// Try to transfer 10,000, which we don't have the allowance for.
		await assert.revert(
			zUSDContract.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient balance', async () => {
		// Issue 10,000 - 1 wei zUSD.
		const amount = toUnit('10000');
		await synthetix.issueSynths(amount.sub(web3.utils.toBN('1')), { from: owner });

		// Approve for full amount
		await zUSDContract.approve(account1, amount, { from: owner });

		// Try to transfer 10,000, which we don't have the balance for.
		await assert.revert(
			zUSDContract.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	describe('invoking issue/burn directly as Issuer', () => {
		beforeEach(async () => {
			// Overwrite Synthetix address to the owner to allow us to invoke issue on the Synth
			await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], { from: owner });
			// now have the synth resync its cache
			await zUSDContract.rebuildCache();
		});
		it('should issue successfully when called by Issuer', async () => {
			const transaction = await zUSDContract.issue(account1, toUnit('10000'), {
				from: owner,
			});
			assert.eventsEqual(
				transaction,
				'Transfer',
				{
					from: ZERO_ADDRESS,
					to: account1,
					value: toUnit('10000'),
				},
				'Issued',
				{
					account: account1,
					value: toUnit('10000'),
				}
			);
		});

		it('should burn successfully when called by Issuer', async () => {
			// Issue a bunch of synths so we can play with them.
			await zUSDContract.issue(owner, toUnit('10000'), {
				from: owner,
			});
			// await synthetix.issueSynths(toUnit('10000'), { from: owner });

			const transaction = await zUSDContract.burn(owner, toUnit('10000'), { from: owner });

			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: toUnit('10000') },
				'Burned',
				{ account: owner, value: toUnit('10000') }
			);
		});
	});

	it('should transfer (ERC20) with no fee', async () => {
		// Issue 10,000 zUSD.
		const amount = toUnit('10000');

		await synthetix.issueSynths(amount, { from: owner });

		// Do a single transfer of all our zUSD.
		const transaction = await zUSDContract.transfer(account1, amount, {
			from: owner,
		});

		// Event should be only a transfer to account1
		assert.eventEqual(
			transaction,

			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await zUSDContract.balanceOf(account1), amount);

		// The fee pool should have zero balance
		assert.bnEqual(await zUSDContract.balanceOf(FEE_ADDRESS), 0);
	});

	describe('transfer / transferFrom And Settle', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 1,000 zUSD.
			amount = toUnit('1000');

			await synthetix.issueSynths(amount, { from: owner });
		});

		describe('suspension conditions', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await zUSDContract.approve(account1, amount, { from: owner });
			});

			['System', 'Synth'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					const synth = toBytes32('zUSD');
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true, synth });
					});
					it('when transferAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							zUSDContract.transferAndSettle(account1, amount, {
								from: owner,
							}),
							'Operation prohibited'
						);
					});
					it('when transferFromAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							zUSDContract.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							}),
							'Operation prohibited'
						);
					});
					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false, synth });
						});
						it('when transferAndSettle() is invoked, it works as expected', async () => {
							await zUSDContract.transferAndSettle(account1, amount, {
								from: owner,
							});
						});
						it('when transferFromAndSettle() is invoked, it works as expected', async () => {
							await zUSDContract.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when zETH is suspended', () => {
				const synth = toBytes32('zETH');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
				});
				it('when transferAndSettle() is invoked for zUSD, it works as expected', async () => {
					await zUSDContract.transferAndSettle(account1, amount, {
						from: owner,
					});
				});
				it('when transferFromAndSettle() is invoked for zUSD, it works as expected', async () => {
					await zUSDContract.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});

		describe('with mock exchanger', () => {
			let exchanger;
			beforeEach(async () => {
				// Note: here we have a custom mock for Exchanger
				// this could use GenericMock if we added the ability for generic functions
				// to emit events and listened to those instead (so here, for Exchanger.settle() we'd
				// need to be sure it was invoked during transferAndSettle())
				exchanger = await MockExchanger.new(synthetix.address);

				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
					from: owner,
				});
				// now have synthetix resync its cache
				await synthetix.rebuildCache();
				await zUSDContract.rebuildCache();
			});
			it('then transferableSynths should be the total amount', async () => {
				assert.bnEqual(await zUSDContract.transferableSynths(owner), toUnit('1000'));
			});

			describe('when max seconds in waiting period is non-zero', () => {
				beforeEach(async () => {
					await exchanger.setMaxSecsLeft('1');
				});
				it('when the synth is attempted to be transferred away by the user, it reverts', async () => {
					await assert.revert(
						zUSDContract.transfer(account1, toUnit('1'), { from: owner }),
						'Cannot transfer during waiting period'
					);
				});
				it('when zEUR is attempted to be transferFrom away by another user, it reverts', async () => {
					await assert.revert(
						zUSDContract.transferFrom(owner, account2, toUnit('1'), { from: account1 }),
						'Cannot transfer during waiting period'
					);
				});
			});

			describe('when reclaim amount is set to 10', async () => {
				const reclaimAmount = toUnit('10');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
				});
				it('then transferableSynths should be the total amount minus the reclaim', async () => {
					assert.bnEqual(await zUSDContract.transferableSynths(owner), toUnit('990'));
				});
				it('should transfer all and settle 1000 zUSD less reclaim amount', async () => {
					// Do a single transfer of all our zUSD.
					await zUSDContract.transferAndSettle(account1, amount, {
						from: owner,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await zUSDContract.balanceOf(account1), expectedAmountTransferred);
				});
				it('should transferFrom all and settle 1000 zUSD less reclaim amount', async () => {
					// Give account1 permission to act on our behalf
					await zUSDContract.approve(account1, amount, { from: owner });

					// Do a single transfer of all our zUSD.
					await zUSDContract.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await zUSDContract.balanceOf(account1), expectedAmountTransferred);
				});
				describe('when account has more balance than transfer amount + reclaim', async () => {
					it('should transfer 50 zUSD and burn 10 zUSD', async () => {
						const transferAmount = toUnit('50');
						// Do a single transfer of all our zUSD.
						await zUSDContract.transferAndSettle(account1, transferAmount, {
							from: owner,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await zUSDContract.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await zUSDContract.balanceOf(account1), expectedAmountTransferred);
					});
					it('should transferFrom 50 zUSD and settle reclaim amount', async () => {
						const transferAmount = toUnit('50');

						// Give account1 permission to act on our behalf
						await zUSDContract.approve(account1, transferAmount, { from: owner });

						// Do a single transferFrom of transferAmount.
						await zUSDContract.transferFromAndSettle(owner, account1, transferAmount, {
							from: account1,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await zUSDContract.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await zUSDContract.balanceOf(account1), expectedAmountTransferred);
					});
				});
			});
			describe('when synth balance after reclamation is less than requested transfer value', async () => {
				let balanceBefore;
				const reclaimAmount = toUnit('600');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
					balanceBefore = await zUSDContract.balanceOf(owner);
				});
				describe('when reclaim 600 zUSD and attempting to transfer 500 zUSD synths', async () => {
					// original balance is 1000, reclaim 600 and should send 400
					const transferAmount = toUnit('500');

					describe('using regular transfer and transferFrom', () => {
						it('via regular transfer it reverts', async () => {
							await assert.revert(
								zUSDContract.transfer(account1, transferAmount, {
									from: owner,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
						it('via transferFrom it also reverts', async () => {
							await zUSDContract.approve(account1, transferAmount, { from: owner });
							await assert.revert(
								zUSDContract.transferFrom(owner, account1, transferAmount, {
									from: account1,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
					});
					describe('using transferAndSettle', () => {
						it('then transferableSynths should be the total amount', async () => {
							assert.bnEqual(await zUSDContract.transferableSynths(owner), toUnit('400'));
						});

						it('should transfer remaining balance less reclaimed', async () => {
							// Do a single transfer of all our zUSD.
							await zUSDContract.transferAndSettle(account1, transferAmount, {
								from: owner,
							});

							// should transfer balanceAfter if less than value
							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await zUSDContract.balanceOf(account1), balanceAfterReclaim);
						});
						it('should transferFrom and send balance minus reclaimed amount', async () => {
							// Give account1 permission to act on our behalf
							await zUSDContract.approve(account1, transferAmount, { from: owner });

							// Do a single transferFrom of transferAmount.
							await zUSDContract.transferFromAndSettle(owner, account1, transferAmount, {
								from: account1,
							});

							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await zUSDContract.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await zUSDContract.balanceOf(account1), balanceAfterReclaim);
						});
					});
				});
			});
		});
	});
	describe('when transferring synths to FEE_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 zUSD.
			amount = toUnit('10000');

			await synthetix.issueSynths(amount, { from: owner });
		});
		it('should transfer to FEE_ADDRESS and recorded as fee', async () => {
			const feeBalanceBefore = await zUSDContract.balanceOf(FEE_ADDRESS);

			// Do a single transfer of all our zUSD.
			const transaction = await zUSDContract.transfer(FEE_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to FEE_ADDRESS
			assert.eventEqual(
				transaction,

				// The original synth transfer
				'Transfer',
				{ from: owner, to: FEE_ADDRESS, value: amount }
			);

			const firstFeePeriod = await feePool.recentFeePeriods(0);
			// FEE_ADDRESS balance of zUSD increased
			assert.bnEqual(await zUSDContract.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amount));

			// fees equal to amount are recorded in feesToDistribute
			assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amount));
		});

		describe('when a non-USD synth exists', () => {
			let zEURContract;

			beforeEach(async () => {
				const zEUR = toBytes32('zEUR');

				// create a new zEUR synth
				({ Synth: zEURContract } = await setupAllContracts({
					accounts,
					existing: {
						ExchangeRates: exchangeRates,
						AddressResolver: addressResolver,
						SystemStatus: systemStatus,
						Issuer: issuer,
						DebtCache: debtCache,
						Exchanger: exchanger,
						FeePool: feePool,
						Synthetix: synthetix,
					},
					contracts: [{ contract: 'Synth', properties: { currencyKey: zEUR } }],
				}));

				const timestamp = await currentTime();

				// Send a price update to guarantee we're not stale.
				await exchangeRates.updateRates([zEUR], ['1'].map(toUnit), timestamp, {
					from: oracle,
				});
				await debtCache.takeDebtSnapshot();
			});

			it('when transferring it to FEE_ADDRESS it should exchange into zUSD first before sending', async () => {
				// allocate the user some zEUR
				await issueSynthsToUser({
					owner,
					issuer,
					addressResolver,
					synthContract: zEURContract,
					user: owner,
					amount,
					synth: zEUR,
				});

				// Get balanceOf FEE_ADDRESS
				const feeBalanceBefore = await zUSDContract.balanceOf(FEE_ADDRESS);

				// balance of zEUR after exchange fees
				const balanceOf = await zEURContract.balanceOf(owner);

				const amountInUSD = await exchangeRates.effectiveValue(zEUR, balanceOf, zUSD);

				// Do a single transfer of all zEUR to FEE_ADDRESS
				await zEURContract.transfer(FEE_ADDRESS, balanceOf, {
					from: owner,
				});

				const firstFeePeriod = await feePool.recentFeePeriods(0);

				// FEE_ADDRESS balance of zUSD increased by USD amount given from exchange
				assert.bnEqual(
					await zUSDContract.balanceOf(FEE_ADDRESS),
					feeBalanceBefore.add(amountInUSD)
				);

				// fees equal to amountInUSD are recorded in feesToDistribute
				assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amountInUSD));
			});
		});
	});

	describe('when transferring synths to ZERO_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 zUSD.
			amount = toUnit('1000');

			await synthetix.issueSynths(amount, { from: owner });
		});
		it('should burn the synths and reduce totalSupply', async () => {
			const balanceBefore = await zUSDContract.balanceOf(owner);
			const totalSupplyBefore = await zUSDContract.totalSupply();

			// Do a single transfer of all our zUSD to ZERO_ADDRESS.
			const transaction = await zUSDContract.transfer(ZERO_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to ZERO_ADDRESS and burn
			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: amount },
				'Burned',
				{ account: owner, value: amount }
			);

			// owner balance should be less amount burned
			assert.bnEqual(await zUSDContract.balanceOf(owner), balanceBefore.sub(amount));

			// total supply of synth reduced by amount
			assert.bnEqual(await zUSDContract.totalSupply(), totalSupplyBefore.sub(amount));
		});
	});
});
