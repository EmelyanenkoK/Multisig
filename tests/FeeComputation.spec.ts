import { Blockchain, SandboxContract, TreasuryContract, prettyLogTransactions } from '@ton/sandbox';
import { beginCell, Cell, internal, toNano, Transaction, storeAccountStorage, storeMessage } from '@ton/core';
import { Multisig, TransferRequest, Action } from '../wrappers/Multisig';
import { Order } from '../wrappers/Order';
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

describe('FeeComputation', () => {
    let multisig_code: Cell;
    let order_code: Cell;

    beforeAll(async () => {
        multisig_code = await compile('Multisig');
        order_code = await compile('Order');
    });

    let blockchain: Blockchain;
    let multisig: SandboxContract<Multisig>;
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

        multisig = blockchain.openContract(Multisig.createFromConfig(config, multisig_code));

        const deployResult = await multisig.sendDeploy(deployer.getSender(), toNano('0.05'));

    });

    it('should send new order', async () => {
        const testAddr = randomAddress();
        const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: randomAddress(), value: toNano('0.017'), body: beginCell().storeUint(123425, 32).endCell()})};
        const orderList:Array<Action> = [testMsg, testMsg, testMsg, testMsg2];
        const res = await multisig.sendNewOrder(deployer.getSender(), orderList, Math.floor(Date.now() / 1000 + 1000));

        /*
          tx0 : external -> treasury
          tx1: treasury -> multisig
          tx2: multisig -> order
        */

        let MULTISIG_INIT_ORDER_GAS = computedGeneric(res.transactions[1]).gasUsed;
        let ORDER_INIT_GAS = computedGeneric(res.transactions[2]).gasUsed;

        console.log(prettyLogTransactions(res.transactions));
        //console.log(blockchain.storage.getContract(multisig.address));
        //console.log(computedGeneric(res.transactions[1]).gasUsed);
        let orderAddress = await multisig.getOrderAddress(0n);
        let order = await blockchain.openContract(Order.createFromAddress(orderAddress));
        let orderBody = (await order.getOrderData()).order;
        let orderBodyStats = collectCellStats(orderBody, []);

        let smc = await blockchain.getContract(orderAddress);
        let accountStorage = beginCell().store(storeAccountStorage(smc.account.account!.storage)).endCell();
        let orderAccountStorageStats = collectCellStats(accountStorage, []);

        let orderStateOverhead = {bits: orderAccountStorageStats.bits - orderBodyStats.bits, cells: orderAccountStorageStats.cells - orderBodyStats.cells};
        console.log("orderStateOverhead", orderStateOverhead);

        let multisigToOrderMessage = beginCell().store(storeMessage(res.transactions[2].inMessage!)).endCell();
        let multisigToOrderMessageStats = collectCellStats(multisigToOrderMessage, []);
        let initOrderStateOverhead = {bits: multisigToOrderMessageStats.bits - orderBodyStats.bits, cells: multisigToOrderMessageStats.cells - orderBodyStats.cells};

        console.log("initOrderStateOverhead", initOrderStateOverhead);

        const firstApproval = await order.sendApprove(deployer.getSender(), 0);
        const secondApproval = await order.sendApprove(second.getSender(), 1);

        expect(secondApproval.transactions).toHaveTransaction({
            from: order.address,
            to: multisig.address,
            success: true,
        });

        /*
          tx0 : external -> treasury
          tx1: treasury -> order
          tx2: order -> treasury (approve)
          tx3: order -> multisig
          tx4+: multisig -> destination
        */
        let orderToMultisigMessage = beginCell().store(storeMessage(secondApproval.transactions[3].inMessage!)).endCell();
        let orderToMultisigMessageStats = collectCellStats(orderToMultisigMessage, []);
        let orderToMultisigMessageOverhead = {bits: orderToMultisigMessageStats.bits - orderBodyStats.bits, cells: orderToMultisigMessageStats.cells - orderBodyStats.cells};


        let ORDER_EXECUTE_GAS = computedGeneric(secondApproval.transactions[1]).gasUsed;
        let MULTISIG_EXECUTE_GAS = computedGeneric(secondApproval.transactions[3]).gasUsed;
        console.log("orderToMultisigMessageOverhead", orderToMultisigMessageOverhead);

        // collect data in one console.log
        console.log(`
        MULTISIG_INIT_ORDER_GAS: ${MULTISIG_INIT_ORDER_GAS}
        ORDER_INIT_GAS: ${ORDER_INIT_GAS}
        ORDER_EXECUTE_GAS: ${ORDER_EXECUTE_GAS}
        MULTISIG_EXECUTE_GAS: ${MULTISIG_EXECUTE_GAS}
        orderStateOverhead: ${JSON.stringify(orderStateOverhead)}
        initOrderStateOverhead: ${JSON.stringify(initOrderStateOverhead)}
        orderToMultisigMessageOverhead: ${JSON.stringify(orderToMultisigMessageOverhead)}
        `);

        let orderCell = await Multisig.packOrder(orderList);

        let timeSpan = 365 * 24 * 3600;
        let orderEstimateOnContract = await multisig.getOrderEstimate(orderList, BigInt(Math.floor(Date.now() / 1000 + timeSpan)));
        let gasEstimate = (MULTISIG_INIT_ORDER_GAS + ORDER_INIT_GAS + ORDER_EXECUTE_GAS + MULTISIG_EXECUTE_GAS) * 1000n;
        let fwdEstimate = 2n * 1000000n +
        BigInt((2 * orderBodyStats.bits + initOrderStateOverhead.bits + orderToMultisigMessageOverhead.bits) +
        (2 * orderBodyStats.cells + initOrderStateOverhead.cells + orderToMultisigMessageOverhead.cells) * 100) * 1000n;
        let storageEstimate = BigInt(Math.floor((orderBodyStats.bits +orderStateOverhead.bits + orderBodyStats.cells * 500 + orderStateOverhead.cells * 500) * timeSpan / 65536));
        let manualFees = gasEstimate + fwdEstimate + storageEstimate;
        console.log("orderEstimates", orderEstimateOnContract, manualFees);

    });


});
