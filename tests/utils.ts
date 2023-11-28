import { randomAddress, compareTransaction, flattenTransaction, FlatTransactionComparable } from "@ton/test-utils";
import {Address, Transaction, Cell, Dictionary} from '@ton/core';

export const differentAddress = (oldAddr:Address) => {

    let newAddr : Address;

    do {
        newAddr = randomAddress(oldAddr.workChain);
    } while(newAddr.equals(oldAddr));

    return newAddr;
}
export const getRandom = (min:number, max:number) => {
    return Math.random() * (max - min) + min;
}

export const getRandomInt = (min:number, max:number) => {
    return Math.round(getRandom(min, max));
}

export const findTransaction = <T extends Transaction>(txs: T[], match: FlatTransactionComparable) => {
    return txs.find(x => compareTransaction(flattenTransaction(x), match));
}

export const getMsgPrices = (configRaw: Cell, workchain: 0 | -1 ) => {

    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const prices = config.get(25 + workchain);

    if(prices === undefined) {
        throw Error("No prices defined in config");
    }

    const sc = prices.beginParse();
    let magic = sc.loadUint(8);

    if(magic != 0xea) {
        throw Error("Invalid message prices magic number!");
    }
    return {
        lumpPrice:sc.loadUintBig(64),
        bitPrice: sc.loadUintBig(64),
        cellPrice: sc.loadUintBig(64),
        ihrPriceFactor: sc.loadUintBig(32),
        firstFrac: sc.loadUintBig(16),
        nextFrac:  sc.loadUintBig(16)
    };
}

export const storageCollected = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    return trans.description.storagePhase ? trans.description.storagePhase.storageFeesCollected : 0n;
};
export const computedGeneric = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    if(trans.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return trans.description.computePhase;
};
