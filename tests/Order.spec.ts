import { beginCell, Cell, internal, toNano } from '@ton/core';
import { Order, OrderConfig } from '../wrappers/Order';
import { Op } from "../Constants";
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress } from '@ton/test-utils';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';

describe('Order', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let orderContract : SandboxContract<Order>;
    let multisigWallet : SandboxContract<TreasuryContract>;
    let signerWallet: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        code =await compile('Order');
        blockchain = await Blockchain.create();
        multisigWallet = await blockchain.treasury('multisig');
        signerWallet   = await blockchain.treasury('signer');
        const mockOrder = beginCell().endCell();

        orderContract = blockchain.openContract(Order.createFromConfig({
            multisig: multisigWallet.address,
            orderSeqno: 0
        }, code));

        const expDate = Math.floor(Date.now() / 1000) + 1000;

        const res = await orderContract.sendDeploy(multisigWallet.getSender(), toNano('1'), [signerWallet.address], expDate, mockOrder);
        expect(res.transactions).toHaveTransaction({deploy: true, success: true});
    });

    it('should deploy', async () => {
        // Happens in beforeAll clause
    });

    it('should approve order', async () => {
        const res = await orderContract.sendApprove(signerWallet.getSender(), 0);

        expect(res.transactions).toHaveTransaction({
            from: signerWallet.address,
            to: orderContract.address,
            success: true,
            outMessagesCount: 2
        });

        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            to: signerWallet.address,
            op: Op.order.approved
        });
        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            to: multisigWallet.address,
            op: Op.multiowner.execute
        });

    });
});

