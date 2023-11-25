import { randomAddress, compareTransaction, flattenTransaction, FlatTransactionComparable } from "@ton/test-utils";
import {Address, Transaction} from '@ton/core';

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
