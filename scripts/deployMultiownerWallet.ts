import { toNano } from 'ton-core';
import { MultiownerWallet } from '../wrappers/MultiownerWallet';
import { compile, NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const multiownerWallet = provider.open(MultiownerWallet.createFromConfig({}, await compile('MultiownerWallet')));

    await multiownerWallet.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(multiownerWallet.address);

    // run methods on `multiownerWallet`
}
