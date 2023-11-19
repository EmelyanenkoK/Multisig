import { CompilerConfig } from '@ton/blueprint';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export const compile: CompilerConfig = {
    lang: 'func',
    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'order_code.func'), `cell order_code() asm "B{${code.toBoc().toString('hex')}} B>boc PUSHREF";`);
    },
    targets: ['contracts/order.func'],
};
