import {toNano} from "ton-core";

export abstract class Op {
    static readonly multiowner = {
        new_order : 0x1,
        execute: 0x2
    }
    static readonly order = {
        approve: 0x8,
        approved: 0x9,
        init: 0x5
    }
    static readonly actions = {
        send_message: 10,
        update_multisig_params: 11,
    }
}
