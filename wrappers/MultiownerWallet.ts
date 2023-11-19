import { Address, beginCell,  Cell, Builder, Dictionary, MessageRelaxed, storeMessageRelaxed, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { Op } from "../Constants";

export type MultiownerWalletConfig = {
    threshold: number;
    signers: Array<Address>;
    proposers: Array<Address>;
    modules: Array<Address>;
    guard: Cell | null;
};

export type TransferRequest = {sendMode:SendMode, message:MessageRelaxed};

function arrayToCell(arr: Array<Address>): Dictionary<number, Address> {
    let dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
    for (let i = 0; i < arr.length; i++) {
        dict.set(i, arr[i]);
    }
    return dict;
}

/*
    (int next_order_seqno, int threshold,
        cell signers, int signers_num,
        cell proposers,
        cell modules, cell guard) = (ds~load_order_seqno(), ds~load_index(),
        ds~load_dict(), ds~load_index(),
        ds~load_dict(),
        ds~load_dict(), ds~load_maybe_ref());
*/
export function multiownerWalletConfigToCell(config: MultiownerWalletConfig): Cell {
    return beginCell()
                .storeUint(0, 32)
                .storeUint(config.threshold, 8)
                .storeDict(arrayToCell(config.signers))
                .storeUint(config.signers.length, 8)
                .storeDict(arrayToCell(config.proposers))
                .storeDict(arrayToCell(config.modules))
                .storeMaybeRef(config.guard)
           .endCell();
}

export class MultiownerWallet implements Contract {

    constructor(readonly address: Address,
                readonly init?: { code: Cell; data: Cell },
                readonly configuration?: MultiownerWalletConfig) {}

    static createFromAddress(address: Address) {
        return new MultiownerWallet(address);
    }

    static createFromConfig(config: MultiownerWalletConfig, code: Cell, workchain = 0) {
        const data = multiownerWalletConfigToCell(config);
        const init = { code, data };
        return new MultiownerWallet(contractAddress(workchain, init), init, config);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0, 32).storeUint(0, 64).endCell(),
        });
    }

    async sendNewOrder(provider: ContractProvider, via: Sender,
           transfers: Array<TransferRequest>,
           expirationDate: number, value: bigint = 200000001n) {

        const addrCmp = (x: Address) => x.equals(via.address!);
        let body = beginCell().storeUint(Op.multiowner.new_order, 32)
                              .storeUint(1, 64);
        if(this.configuration === undefined) {
            throw new Error("Configuration is not set: use createFromConfig or loadConfiguration");
        }
        // check that via.address is in signers
        let addrIdx = this.configuration.signers.findIndex(addrCmp);
        if(addrIdx >= 0) {
           body = body.storeBit(true);
           body = body.storeUint(addrIdx, 8);
        } else {
           addrIdx = this.configuration.proposers.findIndex(addrCmp);
           if (addrIdx < 0) {
            throw new Error("Sender is not a signer or proposer");
           }
           body = body.storeBit(false);
           body = body.storeUint(addrIdx, 8);
        }
        body = body.storeUint(expirationDate, 48);
        // pack transfers to the order_body cell
        let order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        if(transfers.length > 254) {
              throw new Error("Too many transfers, only 254 allowed");
        }
        for (let i = 0; i < transfers.length; i++) {
            let transfer = beginCell().storeUint(Op.actions.send_message, 32)
                                      .storeUint(transfers[i].sendMode, 8)
                                      .store(storeMessageRelaxed(transfers[i].message))
                           .endCell();
            order_dict.set(i, transfer);
        }
        body = body.storeDictDirect(order_dict);

        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value,
            body: body.endCell()
        });
    }

    async getOrderAddress(provider: ContractProvider, orderSeqno: bigint) {
         const { stack } = await provider.get("get_order_address", [{type: "int", value: orderSeqno},]);
         return stack.readAddress();
    }

    async getMultiownerData(provider: ContractProvider) {
        const { stack } = await provider.get("get_multiowner_data", []);
        const nextOrderSeqno = stack.readNumber();
        const threshold = stack.readNumber();
        // TODO: parse signers and proposers to Dicts
        const signers = stack.readCellOpt();
        const proposers = stack.readCellOpt();
        const modules = stack.readCellOpt();
        const guard = stack.readCellOpt();
        return { nextOrderSeqno, threshold, signers, proposers, modules, guard };
    }
}
