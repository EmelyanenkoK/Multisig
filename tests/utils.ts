import { randomAddress, compareTransaction, flattenTransaction, FlatTransactionComparable } from "@ton/test-utils";
import {Address, Transaction, Cell, Dictionary, Message} from '@ton/core';
import { Blockchain, BlockchainTransaction } from "@ton/sandbox";
import { extractEvents } from "@ton/sandbox/dist/event/Event";

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

type MsgQueued = {
    msg: Message,
    parent?: BlockchainTransaction
};
export class Txiterator implements AsyncIterator<BlockchainTransaction>  {
    private msqQueue: MsgQueued[];
    private blockchain: Blockchain;

    constructor(bc:Blockchain, msg: Message) {
        this.msqQueue = [{msg}];
        this.blockchain = bc;
    }

    public async next(): Promise<IteratorResult<BlockchainTransaction>> {
        if(this.msqQueue.length == 0) {
            return {done: true, value: undefined};
        }
        const curMsg = this.msqQueue.shift()!;
        const inMsg  = curMsg.msg;
        if(inMsg.info.type !== "internal")
            throw(Error("Internal only"));
        const smc = await this.blockchain.getContract(inMsg.info.dest);
        const res = smc.receiveMessage(inMsg, {now: this.blockchain.now});
        const bcRes = {
            ...res,
            events: extractEvents(res),
            parent: curMsg.parent,
            children: [],
            externals: []
        }
        for(let i = 0; i < res.outMessagesCount; i++) {
            const outMsg = res.outMessages.get(i)!;
            // Only add internal for now
            if(outMsg.info.type === "internal") {
                this.msqQueue.push({msg:outMsg, parent: bcRes})
            }
        }
        return {done: false, value: bcRes};
    }
};

export const executeTill = async (txs: AsyncIterable<BlockchainTransaction> | AsyncIterator<BlockchainTransaction>, match: FlatTransactionComparable) => {
    let executed: BlockchainTransaction[] = [];
    let txIterable = txs as AsyncIterable<BlockchainTransaction>;
    let txIterator = txs as AsyncIterator<BlockchainTransaction>;
    if(txIterable[Symbol.asyncIterator]) {
        for await (const tx of txIterable) {
            executed.push(tx);
            if(compareTransaction(flattenTransaction(tx), match)) {
                return executed;
            }
        }
    }
    else {
        let iterResult = await txIterator.next();
        while(!iterResult.done){
            executed.push(iterResult.value);
            if(compareTransaction(flattenTransaction(iterResult.value), match)) {
                return executed;
            }
            iterResult = await txIterator.next();
        }
    }
    // Will fail with common error message format
    expect(executed).toHaveTransaction(match);
    return executed;
}
export const executeFrom = async (txs: AsyncIterator<BlockchainTransaction>) => {
    let executed: BlockchainTransaction[] = [];
    let iterResult = await txs.next();
    while(!iterResult.done){
        executed.push(iterResult.value);
        iterResult = await txs.next();
    }
    return executed;
}
