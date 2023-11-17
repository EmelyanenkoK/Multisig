import { Blockchain, SandboxContract } from '@ton-community/sandbox';
import { Cell, toNano } from 'ton-core';
import { MultiownerWallet } from '../wrappers/MultiownerWallet';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';

describe('MultiownerWallet', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('MultiownerWallet');
    });

    let blockchain: Blockchain;
    let multiownerWallet: SandboxContract<MultiownerWallet>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        multiownerWallet = blockchain.openContract(MultiownerWallet.createFromConfig({}, code));

        const deployer = await blockchain.treasury('deployer');

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
});
