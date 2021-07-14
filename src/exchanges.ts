import {
  SynthExchange as SynthExchangeEvent,
  ExchangeReclaim as ExchangeReclaimEvent,
  ExchangeRebate as ExchangeRebateEvent,
} from '../generated/subgraphs/exchanges/Synthetix_0/Synthetix';

import { ExchangeFeeUpdated as ExchangeFeeUpdatedEvent } from '../generated/subgraphs/exchanges/SystemSettings_0/SystemSettings';

import {
  Total,
  PostArchernarTotal,
  DailyTotal,
  FifteenMinuteTotal,
  SynthExchange,
  Exchanger,
  PostArchernarExchanger,
  DailyExchanger,
  FifteenMinuteExchanger,
  ExchangeReclaim,
  ExchangeRebate,
  ExchangeFee,
} from '../generated/subgraphs/exchanges/schema';

import { BigDecimal, BigInt, dataSource, log } from '@graphprotocol/graph-ts';

import {
  getUSDAmountFromAssetAmount,
  etherUnits,
  getLatestRate,
  DAY_SECONDS,
  getTimeID,
  FIFTEEN_MINUTE_SECONDS,
} from './lib/helpers';
import { toDecimal } from './lib/util';

let v219 = BigInt.fromI32(9518914); // Archernar v2.19.x Feb 20, 2020

interface AggregatedTotalEntity {
  trades: BigInt;
  exchangers: BigInt;
  exchangeUSDTally: BigDecimal;
  totalFeesGeneratedInUSD: BigDecimal;
  save: () => void;
}

function populateAggregatedTotalEntity<T extends AggregatedTotalEntity>(entity: T): T {
  entity.trades = BigInt.fromI32(0);
  entity.exchangers = BigInt.fromI32(0);
  entity.exchangeUSDTally = new BigDecimal(BigInt.fromI32(0));
  entity.totalFeesGeneratedInUSD = new BigDecimal(BigInt.fromI32(0));
  return entity;
}

function trackTotals<T extends AggregatedTotalEntity>(
  entity: T,
  existingExchanger: boolean,
  amountInUSD: BigDecimal,
  feesInUSD: BigDecimal,
): void {
  entity.trades = entity.trades.plus(BigInt.fromI32(1));

  if (!existingExchanger) entity.exchangers = entity.exchangers.plus(BigInt.fromI32(1));

  if (amountInUSD && feesInUSD) {
    entity.exchangeUSDTally = entity.exchangeUSDTally.plus(amountInUSD);
    entity.totalFeesGeneratedInUSD = entity.totalFeesGeneratedInUSD.plus(feesInUSD);
  }

  entity.save();
}

export function handleSynthExchange(event: SynthExchangeEvent): void {
  let txHash = event.transaction.hash.toHex();
  let latestFromRate = getLatestRate(event.params.fromCurrencyKey.toString(), txHash);
  let latestToRate = getLatestRate(event.params.toCurrencyKey.toString(), txHash);

  if (latestFromRate == null || latestToRate == null) {
    log.error('handleSynthExchange has an issue in tx hash: {}', [txHash]);
    return;
  }

  let account = event.transaction.from;
  let fromAmountInUSD = getUSDAmountFromAssetAmount(event.params.fromAmount, latestFromRate);
  let toAmountInUSD = getUSDAmountFromAssetAmount(event.params.toAmount, latestToRate);

  let feesInUSD = fromAmountInUSD.minus(toAmountInUSD);

  let entity = new SynthExchange(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.account = event.params.account;
  entity.from = account;
  entity.fromCurrencyKey = event.params.fromCurrencyKey;
  entity.fromAmount = toDecimal(event.params.fromAmount);
  entity.fromAmountInUSD = fromAmountInUSD;
  entity.toCurrencyKey = event.params.toCurrencyKey;
  entity.toAmount = toDecimal(event.params.toAmount);
  entity.toAmountInUSD = toAmountInUSD;
  entity.toAddress = event.params.toAddress;
  entity.feesInUSD = feesInUSD;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  entity.network = 'mainnet';
  entity.save();

  let dayTimestamp = getTimeID(event.block.timestamp, DAY_SECONDS);
  let fifteenMinuteTimestamp = getTimeID(event.block.timestamp, FIFTEEN_MINUTE_SECONDS);

  let total = Total.load('mainnet') || populateAggregatedTotalEntity(new Total('mainnet'));
  let dailyTotal =
    DailyTotal.load(dayTimestamp.toString()) || populateAggregatedTotalEntity(new DailyTotal(dayTimestamp.toString()));
  let fifteenMinuteTotal =
    FifteenMinuteTotal.load(fifteenMinuteTimestamp.toString()) ||
    populateAggregatedTotalEntity(new FifteenMinuteTotal(fifteenMinuteTimestamp.toString()));

  let existingExchanger = Exchanger.load(account.toHex());
  let existingDailyExchanger = DailyExchanger.load(dayTimestamp.toString() + '-' + account.toHex());
  let existingFifteenMinuteExchanger = FifteenMinuteExchanger.load(
    fifteenMinuteTimestamp.toString() + '-' + account.toHex(),
  );

  if (existingExchanger == null) {
    let exchanger = new Exchanger(account.toHex());
    exchanger.save();
  }

  if (existingDailyExchanger == null) {
    let dailyExchanger = new DailyExchanger(dayTimestamp.toString() + '-' + account.toHex());
    dailyExchanger.save();
  }

  if (existingFifteenMinuteExchanger == null) {
    let fifteenMinuteExchanger = new FifteenMinuteExchanger(fifteenMinuteTimestamp.toString() + '-' + account.toHex());
    fifteenMinuteExchanger.save();
  }

  if (dataSource.network() == 'mainnet' && event.block.number > v219) {
    let postArchernarTotal =
      PostArchernarTotal.load('mainnet') || populateAggregatedTotalEntity(new PostArchernarTotal('mainnet'));
    let existingPostArchernarExchanger = PostArchernarExchanger.load(account.toHex());
    if (existingPostArchernarExchanger == null) {
      let postArchernarExchanger = new PostArchernarExchanger(account.toHex());
      postArchernarExchanger.save();
    }
    trackTotals(postArchernarTotal, !!existingPostArchernarExchanger, fromAmountInUSD, feesInUSD);
  }

  trackTotals(total, !!existingExchanger, fromAmountInUSD, feesInUSD);
  trackTotals(dailyTotal, !!existingDailyExchanger, fromAmountInUSD, feesInUSD);
  trackTotals(fifteenMinuteTotal, !!existingFifteenMinuteExchanger, fromAmountInUSD, feesInUSD);
}

export function handleExchangeReclaim(event: ExchangeReclaimEvent): void {
  let txHash = event.transaction.hash.toHex();
  let entity = new ExchangeReclaim(txHash + '-' + event.logIndex.toString());
  entity.account = event.params.account;
  entity.amount = toDecimal(event.params.amount);
  entity.currencyKey = event.params.currencyKey;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  let latestRate = getLatestRate(event.params.currencyKey.toString(), txHash);

  if (latestRate == null) {
    log.error('handleExchangeReclaim has an issue in tx hash: {}', [txHash]);
    return;
  }
  entity.amountInUSD = getUSDAmountFromAssetAmount(event.params.amount, latestRate);
  entity.save();
}

export function handleExchangeRebate(event: ExchangeRebateEvent): void {
  let txHash = event.transaction.hash.toHex();
  let entity = new ExchangeRebate(txHash + '-' + event.logIndex.toString());
  entity.account = event.params.account;
  entity.amount = toDecimal(event.params.amount);
  entity.currencyKey = event.params.currencyKey;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  let latestRate = getLatestRate(event.params.currencyKey.toString(), txHash);

  if (latestRate == null) {
    log.error('handleExchangeReclaim has an issue in tx hash: {}', [txHash]);
    return;
  }
  entity.amountInUSD = getUSDAmountFromAssetAmount(event.params.amount, latestRate);
  entity.save();
}

export function handleFeeChange(event: ExchangeFeeUpdatedEvent): void {
  let currencyKey = event.params.synthKey.toString();

  let entity = new ExchangeFee(currencyKey);
  entity.fee = new BigDecimal(event.params.newExchangeFeeRate);
  entity.fee = entity.fee.div(etherUnits);
  entity.save();
}
