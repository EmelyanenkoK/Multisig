import { Blockchain, SandboxContract, TreasuryContract, prettyLogTransactions } from '@ton/sandbox';
import { beginCell, Cell, internal, toNano } from '@ton/core';
import { MultiownerWallet, TransferRequest } from '../wrappers/MultiownerWallet';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress } from '@ton/test-utils';

describe('MultiownerWallet', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('MultiownerWallet');
    });

    let blockchain: Blockchain;
    let multiownerWallet: SandboxContract<MultiownerWallet>;
    let deployer : SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');

        let config = {
            threshold: 1,
            signers: [deployer.address],
            proposers: [],
            modules: [],
            guard: null,
        };

        multiownerWallet = blockchain.openContract(MultiownerWallet.createFromConfig(config, code));

        const deployResult = await multiownerWallet.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and multiownerWallet are ready to use
    });
    it('should send new order', async () => {
        const testAddr = randomAddress();
        const testMsg: TransferRequest = {sendMode: 0, message: internal({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const res = await multiownerWallet.sendNewOrder(deployer.getSender(), [testMsg], Math.floor(Date.now() / 1000 + 1000));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multiownerWallet.address,
            success: true,
            outMessagesCount: 1
        });
        console.log(prettyLogTransactions(res.transactions));
        expect((await multiownerWallet.getMultiownerData()).nextOrderSeqno).toEqual(1);
    });

});
