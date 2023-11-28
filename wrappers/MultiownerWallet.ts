import { Address, beginCell,  Cell, Dictionary, MessageRelaxed, storeMessageRelaxed, Contract, contractAddress, ContractProvider, Sender, SendMode, internal, toNano } from '@ton/core';
import { Op } from "../Constants";

export type Module = {
    address: Address,
    module: Cell
};
export type MultiownerWalletConfig = {
    threshold: number;
    signers: Array<Address>;
    proposers: Array<Address>;
    modules: Array<Module>;
    guard: Cell | null;
};

export type TransferRequest = { type: 'transfer', sendMode:SendMode, message:MessageRelaxed};
export type UpdateRequest   = {
    type: 'update',
    threshold: number,
    signers: Array<Address>,
    proposers: Array<Address>,
    modules?: Cell, // TODO proper modules packaging
    guard?: Cell
};

export type Action = TransferRequest | UpdateRequest;
export type Order  = Array<Action>;

function arrayToCell(arr: Array<Address>): Dictionary<number, Address> {
    let dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
    for (let i = 0; i < arr.length; i++) {
        dict.set(i, arr[i]);
    }
    return dict;
}

function moduleArrayToCell(arr: Array<Module>) {
    let dict = Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.Cell());
    for (let module of arr) {
        dict.set(module.address, module.module);
    }
    return dict;
}

function cellToArray(addrDict: Cell | null) : Array<Address>  {
    let resArr: Array<Address> = [];
    if(addrDict !== null) {
        const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address(), addrDict);
        resArr = dict.values();
    }
    return resArr;
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
                .storeRef(beginCell().storeDictDirect(arrayToCell(config.signers)))
                .storeUint(config.signers.length, 8)
                .storeDict(arrayToCell(config.proposers))
                .storeDict(moduleArrayToCell(config.modules))
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

    static packTransferRequest(transfer: TransferRequest) {
        let message = beginCell().store(storeMessageRelaxed(transfer.message)).endCell();
        return beginCell().storeUint(Op.actions.send_message, 32)
                          .storeUint(transfer.sendMode, 8)
                          .storeRef(message)
               .endCell();

    }
    static packUpdateRequest(update: UpdateRequest) {
        return beginCell().storeUint(Op.actions.update_multisig_params, 32)
                          .storeUint(update.threshold, 8)
                          .storeRef(beginCell().storeDictDirect(arrayToCell(update.signers)))
                          .storeDict(arrayToCell(update.proposers))
                          .storeMaybeRef(update.modules)
                          .storeMaybeRef(update.guard)
               .endCell();
    }

    packLarge(actions: Array<Action>, address?: Address) {
        return MultiownerWallet.packLarge(actions, address ?? this.address);
    }
    static packLarge(actions: Array<Action>, address: Address) : Cell {
        let packChained = function (req: Cell) : TransferRequest  {
            return {
                type: "transfer",
                sendMode: 1,
                message: internal({
                    to: address,
                    value: toNano('0.01'),
                    body: beginCell().storeUint(Op.multiowner.execute_internal, 32)
                                     .storeUint(0, 64)
                                     .storeRef(req)
                          .endCell()
                })
            }
        };
        let tailChunk : Cell | null = null;
        let chunkCount  = Math.ceil(actions.length / 254);
        let actionProcessed = 0;
        let lastSz      = actions.length % 254;
        while(chunkCount--) {
            let chunkSize : number;
            if(lastSz > 0) {
                chunkSize = lastSz;
                lastSz    = 0;
            }
            else {
                chunkSize = 254
            }

            // Processing chunks from tail to head to evade recursion
            const chunk = actions.slice(-(chunkSize + actionProcessed), actions.length - actionProcessed);

            if(tailChunk === null) {
                tailChunk = MultiownerWallet.packOrder(chunk);
            }
            else {
                // Every next chunk has to be chained with execute_internal
                tailChunk = MultiownerWallet.packOrder([...chunk, packChained(tailChunk)]);
            }

            actionProcessed += chunkSize;
        }

        if(tailChunk === null) {
            throw new Error("Something went wrong during large order pack");
        }

        return tailChunk;
    }
    static packOrder(actions: Array<Action>) {
        let order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        if(actions.length > 255) {
            throw new Error("For action chains above 255, use packLarge method");
        }
        else {
            // pack transfers to the order_body cell
            for (let i = 0; i < actions.length; i++) {
                const action = actions[i];
                const actionCell = action.type === "transfer" ? MultiownerWallet.packTransferRequest(action) : MultiownerWallet.packUpdateRequest(action);
                order_dict.set(i, actionCell);
            }
            return beginCell().storeDictDirect(order_dict).endCell();
        }
    }

    static newOrderMessage(actions: Order | Cell,
                           expirationDate: number,
                           isSigner: boolean,
                           addrIdx: number,
                           query_id: number | bigint = 0) {

       const msgBody = beginCell().storeUint(Op.multiowner.new_order, 32)
                                  .storeUint(query_id, 64)
                                  .storeBit(isSigner)
                                  .storeUint(addrIdx, 8)
                                  .storeUint(expirationDate, 48)

        if(actions instanceof Cell) {
            return msgBody.storeRef(actions).endCell();
        }

        if(actions.length == 0) {
            throw new Error("Order list can't be empty!");
        }
        let order_cell = MultiownerWallet.packOrder(actions);
        return msgBody.storeRef(order_cell).endCell();
    }
    async sendNewOrder(provider: ContractProvider, via: Sender,
           actions: Order | Cell,
           expirationDate: number, value: bigint = 200000000n, addrIdx?: number, isSigner?: boolean ) {

        if(this.configuration === undefined) {
            throw new Error("Configuration is not set: use createFromConfig or loadConfiguration");
        }
        // check that via.address is in signers
        // We can only check in advance when address is known. Otherwise we have to trust isSigner flag
        if(via.address !== undefined) {
            const addrCmp = (x: Address) => x.equals(via.address!);
            addrIdx = this.configuration.signers.findIndex(addrCmp);
            if(addrIdx >= 0) {
               isSigner = true;
            } else {
               addrIdx = this.configuration.proposers.findIndex(addrCmp);
               if (addrIdx < 0) {
                throw new Error("Sender is not a signer or proposer");
               }
               isSigner = false;
            }
        }
        else if(isSigner === undefined || addrIdx == undefined) {
                throw new Error("If sender address is not known, addrIdx and isSigner parameres required");
        }

        let newActions : Cell | Order;

        if(actions instanceof Cell) {
            newActions = actions;
        }
        else if(actions.length > 255) {
            newActions = MultiownerWallet.packLarge(actions, this.address);
        }
        else {
            newActions = MultiownerWallet.packOrder(actions);
        }
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            value,
            body: MultiownerWallet.newOrderMessage(newActions, expirationDate, isSigner, addrIdx, 1)
        });

        //console.log(await provider.get("get_order_address", []));
    }

    async getOrderAddress(provider: ContractProvider, orderSeqno: bigint) {
         const { stack } = await provider.get("get_order_address", [{type: "int", value: orderSeqno},]);
         return stack.readAddress();
    }

    async getOrderEstimate(provider: ContractProvider, order: Order, expiration_date: bigint) {
        const orderCell = MultiownerWallet.packOrder(order);
        const { stack } = await provider.get('get_order_estimate', [{type: "cell", cell: orderCell}, {type: "int", value: expiration_date}]);
        return stack.readBigNumber();
    }

    async getMultiownerData(provider: ContractProvider) {
        const { stack } = await provider.get("get_multiowner_data", []);
        const nextOrderSeqno = stack.readBigNumber();
        const threshold = stack.readBigNumber();
        const signers = cellToArray(stack.readCellOpt());
        const proposers = cellToArray(stack.readCellOpt());
        const modules = stack.readCellOpt();
        const guard = stack.readCellOpt();
        return { nextOrderSeqno, threshold, signers, proposers, modules, guard };
    }
}
