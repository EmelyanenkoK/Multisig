import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from 'ton-core';

export type MultiownerWalletConfig = {};

export function multiownerWalletConfigToCell(config: MultiownerWalletConfig): Cell {
    return beginCell().endCell();
}

export class MultiownerWallet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MultiownerWallet(address);
    }

    static createFromConfig(config: MultiownerWalletConfig, code: Cell, workchain = 0) {
        const data = multiownerWalletConfigToCell(config);
        const init = { code, data };
        return new MultiownerWallet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
