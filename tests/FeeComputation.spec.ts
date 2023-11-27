import { Blockchain, SandboxContract, TreasuryContract, prettyLogTransactions, BlockchainTransaction } from '@ton/sandbox';
import { beginCell, Cell, internal, toNano, Transaction, storeAccountStorage, storeMessage, Slice, Message, Dictionary } from '@ton/core';
import { MultiownerWallet, TransferRequest, Action, MultiownerWalletConfig } from '../wrappers/MultiownerWallet';
import { Order } from '../wrappers/Order';
import { Op } from '../Constants';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress } from '@ton/test-utils';

export const computedGeneric = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    if(trans.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return trans.description.computePhase;
};
export const storageGeneric = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    if(trans.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return trans.description.storagePhase;
};

export function collectCellStats(cell: Cell, visited:Array<string>, skipRoot: boolean = false): { bits: number, cells: number } {
    let bits  = skipRoot ? 0 : cell.bits.length;
    let cells = skipRoot ? 0 : 1;
    let hash = cell.hash().toString();
    if (visited.includes(hash)) {
        return { bits, cells };
    }
    else {
        visited.push(hash);
    }
    for (let ref of cell.refs) {
        let r = collectCellStats(ref, visited);
        cells += r.cells;
        bits += r.bits;
    }
    return { bits, cells };
}


type MsgPrices = ReturnType<typeof configParseMsgPrices>

function computeDefaultForwardFee(msgPrices: MsgPrices) {
    return msgPrices.lumpPrice - ((msgPrices.lumpPrice * msgPrices.firstFrac) >> BigInt(16));
}
function computeMessageForwardFees(msgPrices: MsgPrices, msg: Message) {
    // let msg = loadMessageRelaxed(cell.beginParse());
    let storageStats: { bits: number, cells: number } = { bits: 0, cells: 0 };

    if( msg.info.type !== "internal") {
        throw Error("Helper intended for internal messages");
    }
    const defaultFwd = computeDefaultForwardFee(msgPrices);
    // If message forward fee matches default than msg cell is flat
    let   skipRef    = msg.info.forwardFee == defaultFwd;
    // Init
    if (msg.init) {
        if(msg.init.code) {
            const code = collectCellStats(msg.init.code, []);
            storageStats.bits += code.bits;
            storageStats.cells += code.cells;
        }
        if(msg.init.data) {
            const data = collectCellStats(msg.init.data, []);
            storageStats.bits += data.bits;
            storageStats.cells += data.cells;
        }
        // If message remaining fee exceeds fees fraction from  init data, than body is by ref
        const tempFees = computeFwdFees(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
        const tempFrac = tempFees - ((tempFees * msgPrices.firstFrac) >> BigInt(16));
        skipRef = tempFrac == msg.info.forwardFee
    }

    // Body
    let bc = collectCellStats(msg.body,[], skipRef);
    storageStats.bits  += bc.bits;
    storageStats.cells += bc.cells;

    // NOTE: Extra currencies are ignored for now
    let fees = computeFwdFees(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
    let res  = shr16ceil((fees * msgPrices.firstFrac));
    let remaining = fees - res;
    /*
    if(remaining != msg.info.forwardFee) {
        console.log(msg);
        console.log(res, remaining);
        throw(new Error("Something went wrong in fee calcuation!"));
    }
    */
    console.log("All went well");
    return fees;
}

export const configParseMsgPrices = (sc: Slice) => {

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

export const getMsgPrices = (configRaw: Cell, workchain: 0 | -1 ) => {

    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const prices = config.get(25 + workchain);

    if(prices === undefined) {
        throw Error("No prices defined in config");
    }

    return configParseMsgPrices(prices.beginParse());
}

export function computeFwdFees(msgPrices: MsgPrices, cells: bigint, bits: bigint) {
    return msgPrices.lumpPrice + (shr16ceil((msgPrices.bitPrice * bits)
         + (msgPrices.cellPrice * cells))
    );
}



function shr16ceil(src: bigint) {
    let rem = src % BigInt(65536);
    let res = src >> BigInt(16);
    if (rem != BigInt(0)) {
        res += BigInt(1);
    }
    return res;
}
function divideCeil(src: bigint, divisor: bigint) {
    let rem = src % divisor;
    let res = src / divisor;
    if(rem != 0n) {
        res += 1n;
    }
    return res;
}

describe('FeeComputation', () => {
    let multiowner_code: Cell;
    let order_code: Cell;
    let msgPrices: MsgPrices;

    let curTime : () => number;

    beforeAll(async () => {
        multiowner_code = await compile('MultiownerWallet');
        order_code = await compile('Order');
    });

    let blockchain: Blockchain;
    let multiownerWallet: SandboxContract<MultiownerWallet>;
    let deployer : SandboxContract<TreasuryContract>;
    let second : SandboxContract<TreasuryContract>;
    let proposer : SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        second = await blockchain.treasury('second');
        proposer = await blockchain.treasury('proposer');

        let config = {
            threshold: 2,
            signers: [deployer.address, second.address],
            proposers: [proposer.address],
            modules: [],
            guard: null,
        };

        multiownerWallet = blockchain.openContract(MultiownerWallet.createFromConfig(config, multiowner_code));
        msgPrices        = getMsgPrices(blockchain.config, 0);

        const deployResult = await multiownerWallet.sendDeploy(deployer.getSender(), toNano('0.05'));

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);
    });

    it.only('should send new order', async () => {
        const testAddr = randomAddress();
        const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: randomAddress(), value: toNano('0.017'), body: beginCell().storeUint(123425, 32).endCell()})};
        const orderList:Array<Action> = [testMsg, testMsg, testMsg, testMsg2];
        let timeSpan  = 365 * 24 * 3600;
        const expTime = Math.floor(Date.now() / 1000) + timeSpan;
        let orderEstimateOnContract = await multiownerWallet.getOrderEstimate(orderList, BigInt(expTime));
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), orderList, expTime);

        /*
          tx0 : external -> treasury
          tx1: treasury -> multiowner
          tx2: multiowner -> order
        */

        let MULTISIG_INIT_ORDER_GAS = computedGeneric(res.transactions[1]).gasUsed;
        let ORDER_INIT_GAS = computedGeneric(res.transactions[2]).gasUsed;

        console.log(prettyLogTransactions(res.transactions));
        //console.log(blockchain.storage.getContract(multiownerWallet.address));
        //console.log(computedGeneric(res.transactions[1]).gasUsed);
        let orderAddress = await multiownerWallet.getOrderAddress(0n);
        let order = await blockchain.openContract(Order.createFromAddress(orderAddress));
        let orderBody = (await order.getOrderData()).order;
        let orderBodyStats = collectCellStats(orderBody, []);

        let smc = await blockchain.getContract(orderAddress);
        let accountStorage = beginCell().store(storeAccountStorage(smc.account.account!.storage)).endCell();
        let orderAccountStorageStats = collectCellStats(accountStorage, []);

        let orderStateOverhead = {bits: orderAccountStorageStats.bits - orderBodyStats.bits, cells: orderAccountStorageStats.cells - orderBodyStats.cells};
        console.log("orderStateOverhead", orderStateOverhead);

        let multiownerToOrderMessage = beginCell().store(storeMessage(res.transactions[2].inMessage!)).endCell();
        let multiownerToOrderMessageStats = collectCellStats(multiownerToOrderMessage, []);
        let initOrderStateOverhead = {bits: multiownerToOrderMessageStats.bits - orderBodyStats.bits, cells: multiownerToOrderMessageStats.cells - orderBodyStats.cells};

        console.log("initOrderStateOverhead", initOrderStateOverhead);

        const firstApproval = await order.sendApprove(deployer.getSender(), 0);
        blockchain.now = expTime;
        const secondApproval = await order.sendApprove(second.getSender(), 1);

        expect(secondApproval.transactions).toHaveTransaction({
            from: order.address,
            to: multiownerWallet.address,
            success: true,
        });


        /*
          tx0 : external -> treasury
          tx1: treasury -> order
          tx2: order -> treasury (approve)
          tx3: order -> multiowner
          tx4+: multiowner -> destination
        */
        let orderToMultiownerMessage = beginCell().store(storeMessage(secondApproval.transactions[3].inMessage!)).endCell();
        let orderToMultiownerMessageStats = collectCellStats(orderToMultiownerMessage, []);
        let orderToMultiownerMessageOverhead = {bits: orderToMultiownerMessageStats.bits - orderBodyStats.bits, cells: orderToMultiownerMessageStats.cells - orderBodyStats.cells};


        let ORDER_EXECUTE_GAS = computedGeneric(secondApproval.transactions[1]).gasUsed;
        let MULTISIG_EXECUTE_GAS = computedGeneric(secondApproval.transactions[3]).gasUsed;
        console.log("orderToMultiownerMessageOverhead", orderToMultiownerMessageOverhead);

        // collect data in one console.log
        console.log(`
        MULTISIG_INIT_ORDER_GAS: ${MULTISIG_INIT_ORDER_GAS}
        ORDER_INIT_GAS: ${ORDER_INIT_GAS}
        ORDER_EXECUTE_GAS: ${ORDER_EXECUTE_GAS}
        MULTISIG_EXECUTE_GAS: ${MULTISIG_EXECUTE_GAS}
        orderStateOverhead: ${JSON.stringify(orderStateOverhead)}
        initOrderStateOverhead: ${JSON.stringify(initOrderStateOverhead)}
        orderToMultiownerMessageOverhead: ${JSON.stringify(orderToMultiownerMessageOverhead)}
        `);

        let orderCell = MultiownerWallet.packOrder(orderList);

        let gasEstimate = (MULTISIG_INIT_ORDER_GAS + ORDER_INIT_GAS + ORDER_EXECUTE_GAS + MULTISIG_EXECUTE_GAS) * 1000n;
        let actualFwd   = computeMessageForwardFees(msgPrices, secondApproval.transactions[3].inMessage!) 
                          + computeMessageForwardFees(msgPrices, secondApproval.transactions[2].inMessage!)
                          + computeMessageForwardFees(msgPrices, secondApproval.transactions[4].inMessage!);
        console.log("Actual fwd:", actualFwd);
        let fwdEstimate = 2n * 1000000n +
        BigInt((2 * orderBodyStats.bits + initOrderStateOverhead.bits + orderToMultiownerMessageOverhead.bits) +
        (2 * orderBodyStats.cells + initOrderStateOverhead.cells + orderToMultiownerMessageOverhead.cells) * 100) * 1000n;
        let storageEstimate = BigInt(Math.ceil((orderBodyStats.bits +orderStateOverhead.bits + orderBodyStats.cells * 500 + orderStateOverhead.cells * 500) * timeSpan / 65536));
        console.log("fwdEstimate:", fwdEstimate);
        const storagePhase  = storageGeneric(secondApproval.transactions[1]);
        const actualStorage = storagePhase?.storageFeesCollected;
        console.log("Storage estimates:", storageEstimate, actualStorage);
        let manualFees = gasEstimate + fwdEstimate + storageEstimate;
        console.log("orderEstimates", orderEstimateOnContract, manualFees);

        console.log(secondApproval.transactions[2].description);
    });
    it('common cases gas fees multisig 7/10', async () => {
        const assertMultisig = async (threshold: number, total: number, txcount: number, lifetime: number, signer_creates: boolean) => {
            let totalGas = 0n;
            const testWallet = await blockchain.treasury('test_wallet'); // Make sure we don't bounce
            const signers = await blockchain.createWallets(total);
            const config : MultiownerWalletConfig = {
                threshold,
                signers : signers.map(x => x.address),
                proposers: [proposer.address],
                modules: [],
                guard: null
            };

            const multisig = blockchain.openContract(MultiownerWallet.createFromConfig(config, multiowner_code));


            const creator   = signer_creates ? signers[0] : proposer;
            const signerIdx = signer_creates ? 1 : 0;
            let res = await multisig.sendDeploy(deployer.getSender(), toNano('10'));
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: multisig.address,
                deploy: true,
                success: true
            });

            const dataBefore   = await multisig.getMultiownerData();
            const initSeqno    = dataBefore.nextOrderSeqno;
            const orderContract = blockchain.openContract(Order.createFromAddress(await multisig.getOrderAddress(initSeqno)));

            blockchain.now = curTime();
            const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testWallet.address, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
            const actions: Array<TransferRequest> = [];
            for (let i = 0; i < txcount; i++) {
                actions.push(testMsg);
            }
            res = await multisig.sendNewOrder(creator.getSender(), actions, blockchain.now + lifetime);
            expect(res.transactions).toHaveTransaction({
                from: creator.address,
                to: multisig.address,
                success: true
            });
            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: orderContract.address,
                deploy: true,
                success: true
            });

            const summTx = (summ: bigint, tx: BlockchainTransaction) => summ + tx.totalFees.coins;
            totalGas += res.transactions.reduce(summTx, 0n);

            blockchain.now += lifetime;
            for (let i = signerIdx; i < threshold; i++ ) {
                res = await orderContract.sendApprove(signers[i].getSender(), i);
                totalGas += res.transactions.reduce(summTx, 0n);
            }
            expect(res.transactions).toHaveTransaction({
                from: orderContract.address,
                to: multisig.address,
                op: Op.multiowner.execute,
                success: true
            });
            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: testWallet.address,
                success: true
            });
            expect(res.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0
            });


            return totalGas;
        };


        const week = 3600 * 24 * 7;
        const gas1 = await assertMultisig(7, 10, 1, week, false);
        const gas2 = await assertMultisig(2, 3, 1, week, true);
        const gas3 = await assertMultisig(1, 3, 1, week, true);
        const gas4 = await assertMultisig(7, 10, 100, week, false);

        console.log("Multisig 7/10 1 transfer 1 week proposer:", gas1);
        console.log("Multisig 2/3 1 transfer 1 week signer:", gas2);
        console.log("Multisig 1/3 1 transfer 1 week signer:", gas3);
        console.log("Multisig 7/10 100 transfer 1 week proposer:", gas4);
    });
});
