import { CompilerConfig } from '@ton-community/blueprint';
import { compile as compileFunc } from '@ton-community/blueprint';

export const compile: CompilerConfig = {
    lang: 'func',
    preCompileHook: async () => {
        await compileFunc('Order');
    },
    targets: ['contracts/multiowner_wallet.func'],
};
