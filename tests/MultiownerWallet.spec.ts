import { Blockchain, SandboxContract, TreasuryContract, internal, prettyLogTransactions, BlockchainSnapshot } from '@ton/sandbox';
import { beginCell, Cell, toNano, internal as internal_relaxed, Address, SendMode, Dictionary } from '@ton/core';
import { MultiownerWallet, MultiownerWalletConfig, TransferRequest, UpdateRequest } from '../wrappers/MultiownerWallet';
import { Order } from '../wrappers/Order';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress } from '@ton/test-utils';
import { Op, Errors } from '../Constants';
import { getRandomInt, findTransaction, differentAddress} from './utils';
import { abort } from 'process';

describe('MultiownerWallet', () => {
    let code: Cell;

    let blockchain: Blockchain;
    let multiownerWallet: SandboxContract<MultiownerWallet>;
    let deployer : SandboxContract<TreasuryContract>;
    let proposer : SandboxContract<TreasuryContract>;
    let testMsg : TransferRequest;
    let testAddr : Address;
    let initialState: BlockchainSnapshot;

    let curTime : () => number;

    beforeAll(async () => {
        code = await compile('MultiownerWallet');
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        proposer = await blockchain.treasury('proposer');

        let config = {
            threshold: 1,
            signers: [deployer.address],
            proposers: [proposer.address],
            modules: [],
            guard: null,
        };

        testAddr = randomAddress();
        testMsg = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};

        multiownerWallet = blockchain.openContract(MultiownerWallet.createFromConfig(config, code));

        const deployResult = await multiownerWallet.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            deploy: true,
            success: true,
        });

        initialState = blockchain.snapshot();

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);
    });
    // Each case state is independent
    afterEach(async () => await blockchain.loadFrom(initialState));

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and multiownerWallet are ready to use
    });
    it('only signers and proposers should be able to create order', async () => {
        const testAddr = randomAddress();
        const nobody   = await blockchain.treasury('nobody');


        const initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let   orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);

        blockchain.now = Math.floor(Date.now() / 1000)
        const msgSigner= MultiownerWallet.newOrderMessage([testMsg],  blockchain.now + 1000,
                                                         true, // is signer
                                                         0, // Address index
                                                        );
        // Make sure proposers a checked against list too
        const msgProp  = MultiownerWallet.newOrderMessage([testMsg],  blockchain.now + 1000,
                                                         false, // is signer
                                                         0, // Address index
                                                        );

        let nobodyMsgs = [msgSigner, msgProp];
        for (let nbMessage of nobodyMsgs) {
            let res = await blockchain.sendMessage(internal({
                from: nobody.address,
                to: multiownerWallet.address,
                body: nbMessage,
                value: toNano('1')
            }));

            expect(res.transactions).toHaveTransaction({
                from: nobody.address,
                to: multiownerWallet.address,
                success: false,
                aborted: true,
                exitCode: Errors.multiowner.unauthorized_new_order
            });
        }

        // Sending from valid proposer address should result in order creation
        let res = await blockchain.sendMessage(internal({
            from: proposer.address,
            to: multiownerWallet.address,
            body: msgProp,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : proposer.address,
            to: multiownerWallet.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // But should not trigger execution
        expect(res.transactions).not.toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute
        });

        // Order seqno should increase
        orderAddress = await multiownerWallet.getOrderAddress(initialSeqno + 1n);
        // Now test signer
        res = await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multiownerWallet.address,
            body: msgSigner,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : deployer.address,
            to: multiownerWallet.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // Now execution should trigger, since threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute
        });
    });
    it.skip('order expiration time should exceed current time', async () => {

        const initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let   orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);

        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg], curTime() - 100);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: false,
            aborted: true
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress
        });
    });
    it.skip('should reject order creation with insufficient incomming value', async () => {
        const year = 3600 * 24 * 365;
        const msgValue = toNano('0.2'); // Default sendNewOrder value

        const initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let   orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);

        // I assume default value should not cut it for a yearly storage.
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg], curTime() + year, msgValue);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: false,
            aborted: true,
            exitCode: Errors.multiowner.not_enough_ton
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress
        });
    });
    it.skip('should account for message value in tranfer order', async () => {
        // So we have message thar requests to transfer substantial amount of TON
        const testMsg: TransferRequest = {type: "transfer", sendMode: 1, message: internal_relaxed({to: randomAddress(), value: toNano('100'), body: beginCell().storeUint(12345, 32).endCell()})};

        const initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let   orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);

        // We supply 100 times less, so expect failure
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg], curTime() + 1000, toNano('1'));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            aborted: true,
            success: false
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            deploy: true
        });
    });

    it('deployer order state should match requested', async () => {
        // Let's deploy multisig with randomized parameters

        const signersNum = getRandomInt(10, 20);
        const signers   = await blockchain.createWallets(signersNum);
        const proposers = await blockchain.createWallets(getRandomInt(10, 20));

        let config = {
            threshold: signersNum - getRandomInt(1, 5),
            signers: signers.map(s => s.address),
            proposers: proposers.map(p => p.address),
            modules: [],
            guard: null,
        };

        const testMultisig = blockchain.openContract(MultiownerWallet.createFromConfig(config, code));

        let res = await testMultisig.sendDeploy(signers[0].getSender(), toNano('1'));
        expect(res.transactions).toHaveTransaction({
            to: testMultisig.address,
            deploy: true,
            success: true
        });


        const initialSeqno = (await testMultisig.getMultiownerData()).nextOrderSeqno;
        let   orderAddress = await testMultisig.getOrderAddress(initialSeqno);


        const rndBody = beginCell().storeUint(getRandomInt(100, 1000), 32).endCell();
        const rndMsg : TransferRequest = {type:"transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: rndBody})};
        res = await testMultisig.sendNewOrder(signers[getRandomInt(0, signers.length - 1)].getSender(), [rndMsg], curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: testMultisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const orderData = await orderContract.getOrderData();

        // console.log("Order signers:", orderData.signers);
        // console.log("Orig signers:", config.signers);

        const stringifyAddr = (a: Address) => a.toString();
        expect(orderData.multisig).toEqualAddress(testMultisig.address);
        expect(orderData.signers.map(stringifyAddr)).toEqual(config.signers.map(stringifyAddr));
        expect(orderData.executed).toBe(false);
        expect(orderData.threshold).toEqual(config.threshold);
        expect(orderData.approvals_num).toBe(1);
    });
    it('should execute new message order', async () => {
        let initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        // await blockchain.setVerbosityForAddress(multiownerWallet.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg], Math.floor(curTime() + 100));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multiownerWallet.getMultiownerData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            success: true
        });
        // one signer and threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });
    it('should should be possible to execute order by post init approval', async () => {
        // Same test as above, but with manulal approval
        let initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        // Gets deployed by proposer, so first approval is not granted right away
        let res = await multiownerWallet.sendNewOrder(proposer.getSender(), [testMsg], Math.floor(curTime() + 100));

        expect(res.transactions).toHaveTransaction({
            from: proposer.address,
            to: multiownerWallet.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multiownerWallet.getMultiownerData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const dataBefore = await orderContract.getOrderData();

        expect(dataBefore.approvals_num).toBe(0);
        expect(dataBefore.executed).toBe(false);

        // Here goes the approval
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            success: true
        });
        // one signer and threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });

    /*
    TODO
    it('order estimate should work', async () => {
        const testMsg: TransferRequest = {type: "transfer", sendMode: 1, message: internal_relaxed({to: randomAddress(), value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const hrEst = await multiownerWallet.getOrderEstimate(testMsg, BigInt(curTime() + 3600));
        console.log("Estimate for one hour:", hrEst);
        const yearEst = await multiownerWallet.getOrderEstimate(testMsg, BigInt(curTime() + 3600 * 24 * 365));
        console.log("Estimate for yearly storage:", yearEst);
        console.log("Storage delta:", yearEst - hrEst);
    });*/
    it('should send new order with many actions in specified order', async () => {
        const testAddr1 = randomAddress();
        const testAddr2 = randomAddress();
        const testMsg1: TransferRequest = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr1, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type : "transfer", sendMode: 1, message: internal_relaxed({to: testAddr2, value: toNano('0.016'), body: beginCell().storeUint(12346, 32).endCell()})};
        let initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg1, testMsg2], Math.floor(Date.now() / 1000 + 1000));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multiownerWallet.getMultiownerData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            success: true
        });

        let order1Tx = findTransaction(res.transactions, {
            from: multiownerWallet.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        expect(order1Tx).not.toBeUndefined();
        let order2Tx = findTransaction(res.transactions, {
            from: multiownerWallet.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });

        expect(order2Tx).not.toBeUndefined();
        expect(order2Tx!.lt).toBeGreaterThan(order1Tx!.lt);
        // Let's switch the order

        res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg2, testMsg1], Math.floor(Date.now() / 1000 + 1000));

        order1Tx = findTransaction(res.transactions, {
            from: multiownerWallet.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        expect(order1Tx).not.toBeUndefined();
        order2Tx = findTransaction(res.transactions, {
            from: multiownerWallet.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });
        expect(order2Tx).not.toBeUndefined();
        // Now second comes first
        expect(order2Tx!.lt).toBeLessThan(order1Tx!.lt);
    });
    it('should execute update multisig parameters correctly', async () => {
        const newSigner = await blockchain.treasury('new_signer');
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: 4,
            signers: [newSigner.address],
            proposers: []
        };
        let initialSeqno = (await multiownerWallet.getMultiownerData()).nextOrderSeqno;
        let res = await multiownerWallet.sendNewOrder(deployer.getSender(), [updOrder], Math.floor(Date.now() / 1000 + 1000));

        expect((await multiownerWallet.getMultiownerData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multiownerWallet.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddress,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            success: true
        });

        const dataAfter = await multiownerWallet.getMultiownerData();
        expect(dataAfter.threshold).toEqual(BigInt(updOrder.threshold));
        expect(dataAfter.signers[0]).toEqualAddress(newSigner.address);
        expect(dataAfter.proposers.length).toBe(0);
    });
    it('should reject multisig parameters with inconsistently ordered signers or proposers', async () => {
        // To produce inconsistent dictionary we have to craft it manually
        const malformed = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        malformed.set(0, randomAddress());
        malformed.set(2, randomAddress());
        let updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                   .storeUint(4, 8)
                   .storeDict(malformed) // signers
                   .storeDict(null) // empty proposers
                   .storeDict(null) // empty modules
                   .storeMaybeRef(null) // empty guard.
        .endCell();

        const orderDict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        orderDict.set(0, updateCell);

        let orderCell = beginCell().storeDictDirect(orderDict).endCell();

        let dataBefore   = await multiownerWallet.getMultiownerData();
        let orderAddress = await multiownerWallet.getOrderAddress(dataBefore.nextOrderSeqno);
        let res = await multiownerWallet.sendNewOrder(deployer.getSender(), orderCell, curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multiowner.invalid_dictionary_sequence
        });

        const stringify = (x: Address) => x.toString();
        let dataAfter = await multiownerWallet.getMultiownerData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));
        expect(dataAfter.modules).toEqual(dataBefore.modules);
        expect(dataAfter.guard).toEqual(dataBefore.guard);

        dataBefore   = await multiownerWallet.getMultiownerData();
        orderAddress = await multiownerWallet.getOrderAddress(dataBefore.nextOrderSeqno);

        // Now let's test if proposers order is checked
        malformed.clear();
        // Let's be bit sneaky. It's kinda consistent, but starts with 1. Should fail anyways.
        malformed.set(1, randomAddress());
        malformed.set(2, randomAddress());

        updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                                .storeUint(4, 8)
                                .storeDict(null) // Empty signers? Yes, that is allowed
                                .storeDict(malformed) // proposers
                                .storeDict(null) // modules
                                .storeMaybeRef(null)  // guard
                     .endCell();

        // All over again
        orderDict.set(0, updateCell);
        orderCell = beginCell().storeDictDirect(orderDict).endCell();

        res = await multiownerWallet.sendNewOrder(deployer.getSender(), orderCell, curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multiowner.invalid_dictionary_sequence
        });

        dataAfter = await multiownerWallet.getMultiownerData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));
        expect(dataAfter.modules).toEqual(dataBefore.modules);
        expect(dataAfter.guard).toEqual(dataBefore.guard);
    });
    it('should accept execute internal only from self address', async () => {
        const nobody = await blockchain.treasury('nobody');
        // Let's test every role
        const roles = [deployer, proposer, nobody];
        const testAddr  = randomAddress();
        const testReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: beginCell().storeUint(0x12345, 32).endCell()
            })
        };

        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, MultiownerWallet.packTransferRequest(testReq));
        const testBody = beginCell().storeUint(Op.multiowner.execute_internal, 32)
                                    .storeUint(0, 64)
                                    .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                         .endCell();

        for (let testWallet of roles) {
            let res = await blockchain.sendMessage(internal({
                from: testWallet.address,
                to: multiownerWallet.address,
                value: toNano('1'),
                body: testBody
            }));
            expect(res.transactions).toHaveTransaction({
                from: testWallet.address,
                to: multiownerWallet.address,
                op: Op.multiowner.execute_internal,
                aborted: true
            });
            expect(res.transactions).not.toHaveTransaction({
                from: multiownerWallet.address,
                to: testAddr
            });
        }
    });
    it('chained execution should work', async () => {

        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();
        const chainedReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: testBody
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, MultiownerWallet.packTransferRequest(chainedReq));
        const triggerReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multiownerWallet.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multiowner.execute_internal, 32)
                            .storeUint(0, 64)
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                  .endCell()
            })
        };
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [triggerReq], curTime() + 1000, toNano('1'));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: true
        });
        // Self message
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: multiownerWallet.address,
            op: Op.multiowner.execute_internal,
            success: true
        });
        // Chained message
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: testAddr,
            value: toNano('0.01'),
            body: testBody
        });
    });
    it('multiowner should invalidate previous orders if signers change', async () => {
        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();

        const dataBefore = await multiownerWallet.getMultiownerData();
        const orderAddr    = await multiownerWallet.getOrderAddress(dataBefore.nextOrderSeqno);
        const testMsg: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multiownerWallet.address,
                value: toNano('0.015'),
                body: testBody
            })
        };
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: Number(dataBefore.threshold),
            signers: [differentAddress(deployer.address)],
            proposers: dataBefore.proposers
        };

        // First we deploy order with proposer, so it doesn't execute right away
        let res = await multiownerWallet.sendNewOrder(proposer.getSender(), [testMsg], curTime() + 1000);
        expect(res.transactions).toHaveTransaction({
            from: multiownerWallet.address,
            to: orderAddr,
            deploy: true,
            success: true
        });
        // Now lets perform signers update
        res = await multiownerWallet.sendNewOrder(deployer.getSender(), [updOrder], curTime() + 100);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: true
        });
        expect((await multiownerWallet.getMultiownerData()).signers[0]).not.toEqualAddress(dataBefore.signers[0]);

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddr));
        // Now let's approve old order
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddr,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multiowner.singers_outdated
        });
    });
    it('multiowner should not execute orders deployed by other multiowner contract', async () => {
        const coolHacker = await blockchain.treasury('1337');
        const newConfig : MultiownerWalletConfig = {
            threshold: 1,
            signers: [coolHacker.address], // So deployment init is same except just one field (so still different address)
            proposers: [proposer.address],
            modules: [],
            guard: null
        };

        const evilMultiowner = blockchain.openContract(MultiownerWallet.createFromConfig(newConfig,code));

        const legitData = await multiownerWallet.getMultiownerData();
        let res = await evilMultiowner.sendDeploy(coolHacker.getSender(), toNano('10'));
        expect(res.transactions).toHaveTransaction({
            from: coolHacker.address,
            to: evilMultiowner.address,
            deploy: true,
            success: true
        });
        const evilPayload: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: coolHacker.address,
                value: toNano('100000'), // Evil enough? Could have changed multisig params even
                body: beginCell().storeUint(1337, 32).endCell()
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, MultiownerWallet.packTransferRequest(evilPayload));

        const mock_signers = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        // Copy the real signers
        for (let i = 0; i < legitData.signers.length; i++) {
            mock_signers.set(i, legitData.signers[i]);
        }
        const evalOrder: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multiownerWallet.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multiowner.execute, 32)
                            .storeUint(0, 64)
                            .storeUint(legitData.nextOrderSeqno, 32)
                            .storeUint(BigInt('0x' + beginCell().storeDictDirect(mock_signers).endCell().hash().toString('hex')), 256) // pack legit hash
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell()) // Finally eval payload
                  .endCell()
            })
        };

        res = await evilMultiowner.sendNewOrder(coolHacker.getSender(), [evalOrder], curTime() + 100);

        expect(res.transactions).toHaveTransaction({
            from: evilMultiowner.address,
            to: multiownerWallet.address,
            op: Op.multiowner.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multiowner.unauthorized_execute
        });
        // No funds exfiltrated
        expect(res.transactions).not.toHaveTransaction({
            from: multiownerWallet.address,
            to: coolHacker.address
        });
    });
});
// TODO EXPERIMENTAL AND MORE VERBOSE GUARANTEES CASES
