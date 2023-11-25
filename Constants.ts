export abstract class Op {
    static readonly multiowner = {
        new_order : 0x1,
        execute: 0x2,
        execute_internal: 0x3
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

export abstract class Errors {
    static readonly multiowner = {
        unauthorized_new_order : 1007,
        not_enough_ton : 100,
        unauthorized_execute : 101,
        singers_outdated : 102,
        invalid_dictionary_sequence: 103
    }
};


