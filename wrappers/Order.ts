import { Address, beginCell,  Cell, Builder, BitString, Dictionary, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { Op } from "../Constants";

export type OrderConfig = {
    multisig: Address,
    orderSeqno: number
};

function arrayToCell(arr: Array<Address>): Dictionary<number, Address> {
    let dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
    for (let i = 0; i < arr.length; i++) {
        dict.set(i, arr[i]);
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

export function orderConfigToCell(config: OrderConfig): Cell {
    return beginCell()
                .storeAddress(config.multisig)
                .storeUint(config.orderSeqno, 32)
           .endCell();
}

export class Order implements Contract {
    constructor(readonly address: Address,
                readonly init?: { code: Cell, data: Cell },
                readonly configuration?: OrderConfig) {}
    
    static createFromAddress(address: Address) {
        return new Order(address);
    }

    static createFromConfig(config: OrderConfig, code: Cell, workchain = 0) {
        const data = orderConfigToCell(config);
        const init = { code, data };

        return new Order(contractAddress(workchain, init), init, config);
    }

    async sendDeploy(provider: ContractProvider,
                     via: Sender,
                     value: bigint,
                     signers: Array<Address>,
                     expiration_date: number,
                     order: Cell,
                     threshold: number = 1,
                     approve_on_init: boolean = false,
                     signer_idx: number = 0,
                     query_id : number | bigint = 0) {
       const msgBody = beginCell()
                        .storeUint(Op.order.init, 32)
                        .storeUint(query_id, 64)
                        .storeUint(threshold, 8)
                        .storeDict(arrayToCell(signers))
                        .storeUint(signers.length, 8)
                        .storeUint(expiration_date, 48)
                        .storeRef(order)
                        .storeBit(approve_on_init);

       if(approve_on_init) {
           msgBody.storeUint(signer_idx, 8)
       }


       await provider.internal(via, {
           value,
           sendMode: SendMode.PAY_GAS_SEPARATELY,
           body: msgBody.endCell()
       });
    }

    async sendApprove(provider: ContractProvider, via: Sender, signer_idx: number, value: bigint = toNano('0.1'), query_id: number | bigint = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                    .storeUint(Op.order.approve, 32)
                    .storeUint(query_id, 64)
                    .storeUint(signer_idx, 8)
                  .endCell()
        });
    }


    async getOrderData(provider: ContractProvider) {
       /*
       (slice multisig, int order_seqno, int threshold,
                     int executed?, cell signers, int signers_num,
                     int approvals, int approvals_num, int expiration_date,
                     cell order)
       */
       const { stack } = await provider.get("get_order_data", []);
       const multisig = stack.readAddress();
       const order_seqno = stack.readBigNumber();
       const threshold = stack.readNumber();
       const executed = stack.readBoolean();
       const signers = cellToArray(stack.readCell());
       const signers_num = stack.readBigNumber();
       const approvals = Buffer.from(stack.readBigNumber().toString(16), 'hex');
       const approvals_num = stack.readNumber();
       const expiration_date = stack.readBigNumber();
       const order = stack.readCell();
       return {
              multisig, order_seqno, threshold, executed, signers, signers_num,
                approvals: new BitString(approvals, 0, approvals_num), approvals_num, expiration_date, order
       };
    }
}
