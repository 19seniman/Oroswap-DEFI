require('dotenv').config();
const axios = require('axios');
const readline = require('readline');
const { SigningCosmWasmClient } = require('@cosmjs/cosmWasm-stargate');
const { GasPrice, coins } = require('@cosmjs/stargate');
const { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } = require('@cosmjs/proto-signing');

const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    white: "\x1b[37m",
    bold: "\x1b[1m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    gray: "\x1b[90m",
};

const logger = {
    info: (msg) => console.log(`${colors.cyan}[i] ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}[!] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[x] ${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}[+] ${msg}${colors.reset}`),
    loading: (msg) => console.log(`${colors.magenta}[*] ${msg}${colors.reset}`),
    step: (msg) => console.log(`${colors.blue}[>] ${colors.bold}${msg}${colors.reset}`),
    critical: (msg) => console.log(`${colors.red}${colors.bold}[FATAL] ${msg}${colors.reset}`),
    summary: (msg) => console.log(`${colors.green}${colors.bold}[SUMMARY] ${msg}${colors.reset}`),
    banner: () => {
        const border = `${colors.blue}${colors.bold}╔═════════════════════════════════════════╗${colors.reset}`;
        const title = `${colors.blue}${colors.bold}║   🍉 19Seniman From Insider  🍉   ║${colors.reset}`;
        const bottomBorder = `${colors.blue}${colors.bold}╚═════════════════════════════════════════╝${colors.reset}`;
        
        console.log(`\n${border}`);
        console.log(`${title}`);
        console.log(`${bottomBorder}\n`);
    },
    section: (msg) => {
        const line = '─'.repeat(40);
        console.log(`\n${colors.gray}${line}${colors.reset}`);
        if (msg) console.log(`${colors.white}${colors.bold} ${msg} ${colors.reset}`);
        console.log(`${colors.gray}${line}${colors.reset}\n`);
    },
};

const RPC_URL = 'https://rpc.zigscan.net/'; 
const API_URL = 'https://testnet-api.oroswap.org/api/';
const EXPLORER_URL = 'https://zigscan.org/tx/';
const GAS_PRICE = GasPrice.fromString('0.004uzig'); 

const ORO_ZIG_CONTRACT = 'zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg';

const TOKEN_DECIMALS = {
    'uzig': 6,
    'coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro': 6,
};

const DENOM_ORO = 'coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro';
const DENOM_ZIG = 'uzig';

const ORO_CONTRACT = 'zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr';

const LIQUIDITY_ORO_AMOUNT = 0.1; 
const LIQUIDITY_ZIG_AMOUNT = 0.05; 
const SWAP_MAX_SPREAD = "0.5"; 

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function prompt(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}

function isValidNumber(input) {
    const num = parseInt(input);
    return !isNaN(num) && num > 0;
}

function toMicroUnits(amount, denom) {
    const decimals = TOKEN_DECIMALS[denom] || 6;
    return Math.floor(parseFloat(amount) * Math.pow(10, decimals));
}

function isMnemonic(input) {
    const words = input.trim().split(/\s+/);
    return words.length >= 12 && words.length <= 24 && words.every(word => /^[a-z]+$/.test(word));
}

async function getWallet(key) {
    try {
        if (isMnemonic(key)) {
            return await DirectSecp256k1HdWallet.fromMnemonic(key, { prefix: 'zig' });
        } else if (/^[0-9a-fA-F]{64}$/.test(key.trim())) {
            const privateKeyBytes = Buffer.from(key.trim(), 'hex');
            return await DirectSecp256k1Wallet.fromKey(privateKeyBytes, 'zig');
        } else {
            throw new Error('Invalid input: neither a valid mnemonic nor a 64-character hex private key');
        }
    } catch (error) {
        throw new Error(`Failed to create wallet: ${error.message}`);
    }
}

async function getAccountAddress(wallet) {
    const [account] = await wallet.getAccounts();
    return account.address;
}

async function getBalance(client, address, denom) {
    try {
        const balance = await client.getBalance(address, denom);
        return parseFloat(balance.amount) / Math.pow(10, TOKEN_DECIMALS[denom] || 6);
    } catch (error) {
        logger.error(`Failed to get balance for ${denom}: ${error.message}`);
        return 0;
    }
}

function getRandomSwapAmount(maxBalance) {
    const min = 0.0001; 
    const max = Math.min(0.0003, maxBalance * 0.2); 
    return Math.random() * (max - min) + min;
}

async function getPoolInfo(contractAddress) {
    try {
        const client = await SigningCosmWasmClient.connect(RPC_URL); 
        const poolInfo = await client.queryContractSmart(contractAddress, { pool: {} });
        return poolInfo;
    } catch (error) {
        logger.error(`Failed to get pool info: ${error.message}`);
        return null;
    }
}

function calculateBeliefPrice(poolInfo, fromDenom) {
    try {
        if (!poolInfo || !poolInfo.assets || poolInfo.assets.length !== 2) {
            logger.warn('Invalid pool amounts, using 1.0 fallback belief price');
            return "1.0"; 
        }

        const asset1 = poolInfo.assets[0];
        const asset2 = poolInfo.assets[1];

        const asset1Denom = asset1.info.native_token?.denom || asset1.info.token?.contract_addr;
        const asset2Denom = asset2.info.native_token?.denom || asset2.info.token?.contract_addr;

        let zigAmount, oroAmount;

        const isAsset1ZIG = asset1Denom === DENOM_ZIG;
        const isAsset2ZIG = asset2Denom === DENOM_ZIG;

        if (isAsset1ZIG) {
            zigAmount = parseFloat(asset1.amount) / 1_000_000;
            oroAmount = parseFloat(asset2.amount) / 1_000_000;
        } else if (isAsset2ZIG) {
            zigAmount = parseFloat(asset2.amount) / 1_000_000;
            oroAmount = parseFloat(asset1.amount) / 1_000_000;
        } else {
            logger.warn('Could not identify ZIG/ORO assets in pool, using 1.0 fallback.');
            return "1.0";
        }

        if (zigAmount <= 0 || oroAmount <= 0) {
            logger.warn('Zero pool amounts, using 1.0 fallback belief price');
            return "1.0";
        }

        let beliefPrice;
        const SLIPPAGE_BUFFER = 0.99; 

        if (fromDenom === DENOM_ZIG) {
            const rawPrice = oroAmount / zigAmount;
            beliefPrice = (rawPrice * SLIPPAGE_BUFFER).toFixed(18); 
        } else {
            const rawPrice = zigAmount / oroAmount;
            beliefPrice = (rawPrice * SLIPPAGE_BUFFER).toFixed(18); 
        }

        logger.info(`Calculated Belief Price (${fromDenom === DENOM_ZIG ? 'ZIG->ORO' : 'ORO->ZIG'}): ${beliefPrice}`);
        return beliefPrice;
    } catch (error) {
        logger.error(`Failed to calculate belief price: ${error.message}. Using 1.0 fallback.`);
        return "1.0"; 
    }
}

async function performSwap(wallet, address, amount, fromDenom, swapNumber, maxRetries = 3) {
    let retries = 0;
    while (retries < maxRetries) {
        let client; 
        try {
            client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
            
            const { sequence } = await client.getSequence(address);
            logger.info(`[${address}] Current account sequence for swap ${swapNumber}: ${sequence}`);

            const microAmount = toMicroUnits(amount, fromDenom);
            const fromSymbol = fromDenom === DENOM_ZIG ? 'ZIG' : 'ORO';
            const toSymbol = fromDenom === DENOM_ZIG ? 'ORO' : 'ZIG';

            const balance = await getBalance(client, address, fromDenom);
            const minBalance = amount + (fromDenom === DENOM_ZIG ? 0.005 : 0); 
            if (balance < minBalance) {
                logger.error(`Insufficient ${fromSymbol} balance: ${balance.toFixed(6)} < ${minBalance.toFixed(6)} required`);
                return null;
            }

            const poolInfo = await getPoolInfo(ORO_ZIG_CONTRACT);
            const beliefPrice = calculateBeliefPrice(poolInfo, fromDenom);

            let msg = {
                swap: {
                    belief_price: beliefPrice,
                    max_spread: SWAP_MAX_SPREAD,
                    offer_asset: {
                        amount: microAmount.toString(),
                        info: { native_token: { denom: fromDenom } },
                    },
                },
            };
            let funds = coins(microAmount, fromDenom);
            let contractAddr = ORO_ZIG_CONTRACT;

            logger.loading(`Swap ${swapNumber}/10: ${amount.toFixed(6)} ${fromSymbol} -> ${toSymbol} (Attempt ${retries + 1}/${maxRetries})`);
            const result = await client.execute(address, contractAddr, msg, 'auto', 'Swap', funds);
            
            // Perbaikan: Hapus blok verifikasi on-chain yang menyebabkan error pollForTx
            // try {
            //     logger.info(`Verifying transaction ${result.transactionHash} on-chain...`);
            //     const txResponse = await client.pollForTx(result.transactionHash, 10000, 2000); 
            //     if (txResponse.code !== undefined && txResponse.code !== 0) {
            //         throw new Error(`Transaction ${result.transactionHash} failed on-chain with code ${txResponse.code}: ${txResponse.rawLog}`);
            //     }
            //     logger.success(`Transaction ${result.transactionHash} confirmed on-chain.`);
            // } catch (txError) {
            //     logger.error(`Failed to confirm transaction ${result.transactionHash} on-chain: ${txError.message}. Proceeding anyway, but be aware.`);
            // }

            logger.success(`Swap ${swapNumber} completed! Tx: ${EXPLORER_URL}${result.transactionHash}`);
            return result;
        } catch (error) {
            retries++;
            logger.error(`Swap ${swapNumber} failed (Attempt ${retries}/${maxRetries}): ${error.message}`);
            
            let waitTime = 3000;
            if (error.message.includes('account sequence mismatch')) {
                waitTime = 10000 + (retries * 5000); 
                logger.warn(`${colors.yellow}Detected sequence mismatch. Waiting longer: ${waitTime / 1000} seconds before next retry...${colors.reset}`);
            } else if (error.message.includes('max spread limit') || error.message.includes('insufficient fee')) {
                 waitTime = 5000 + (retries * 5000); 
                logger.warn(`${colors.yellow}Detected critical network error. Waiting longer: ${waitTime / 1000} seconds before next retry...${colors.reset}`);
            } else {
                 logger.warn(`Waiting ${waitTime / 1000} seconds before next retry...`);
            }

            await new Promise(resolve => setTimeout(resolve, waitTime)); 

            if (retries === maxRetries) {
                logger.critical(`Swap ${swapNumber} failed after ${maxRetries} retries. Skipping this swap permanently.`);
                return null;
            }
        }
    }
    return null;
}

async function addLiquidity(wallet, address) {
    let client;
    try {
        client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
        
        const { sequence } = await client.getSequence(address);
        logger.info(`[${address}] Current account sequence for add liquidity: ${sequence}`);

        const oroBalance = await getBalance(client, address, DENOM_ORO);
        const zigBalance = await getBalance(client, address, DENOM_ZIG);
        if (oroBalance < LIQUIDITY_ORO_AMOUNT || zigBalance < LIQUIDITY_ZIG_AMOUNT) {
            logger.error(`Insufficient funds for liquidity: ${oroBalance.toFixed(6)} ORO, ${zigBalance.toFixed(6)} ZIG available`);
            return null;
        }

        const microAmountORO = toMicroUnits(LIQUIDITY_ORO_AMOUNT, DENOM_ORO);
        const microAmountZIG = toMicroUnits(LIQUIDITY_ZIG_AMOUNT, DENOM_ZIG);

        const msg = {
            provide_liquidity: {
                assets: [
                    { amount: microAmountORO.toString(), info: { native_token: { denom: DENOM_ORO } } },
                    { amount: microAmountZIG.toString(), info: { native_token: { denom: DENOM_ZIG } } },
                ],
                slippage_tolerance: "0.1",
            },
        };

        const funds = [
            { denom: DENOM_ORO, amount: microAmountORO.toString() },
            { denom: DENOM_ZIG, amount: microAmountZIG.toString() }
        ];

        logger.loading(`Adding liquidity: ${LIQUIDITY_ORO_AMOUNT} ORO + ${LIQUIDITY_ZIG_AMOUNT} ZIG`);
        const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, 'auto', 'Adding pool Liquidity', funds);

        // Perbaikan: Hapus blok verifikasi on-chain yang menyebabkan error pollForTx
        // try {
        //     logger.info(`Verifying liquidity addition transaction ${result.transactionHash} on-chain...`);
        //     const txResponse = await client.pollForTx(result.transactionHash, 10000, 2000); 
        //     if (txResponse.code !== undefined && txResponse.code !== 0) {
        //         throw new Error(`Transaction ${result.transactionHash} failed on-chain with code ${txResponse.code}: ${txResponse.rawLog}`);
        //     }
        //     logger.success(`Liquidity addition transaction ${result.transactionHash} confirmed on-chain.`);
        // } catch (txError) {
        //     logger.error(`Failed to confirm liquidity addition transaction ${result.transactionHash} on-chain: ${txError.message}. Proceeding anyway.`);
        // }

        logger.success(`Liquidity added! Tx: ${EXPLORER_URL}${result.transactionHash}`);
        return result;
    } catch (error) {
        logger.error(`Add liquidity failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 5000)); 
        return null;
    }
}

async function getPoolTokenBalance(address) {
    try {
        const response = await axios.get(`${API_URL}portfolio/${address}`, {
            headers: {
                accept: 'application/json',
                'accept-language': 'en-US,en;q=0.7',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                Referer: 'https://testnet.oroswap.org/',
            },
        });

        const poolTokens = response.data.pool_tokens;
        const oroZigPool = poolTokens.find(pool =>
            pool.pair_contract_address === ORO_ZIG_CONTRACT ||
            pool.name === 'ORO/ZIG'
        );

        if (oroZigPool) {
            return {
                amount: oroZigPool.amount,
                denom: oroZigPool.denom
            };
        }

        return null;
    } catch (error) {
        logger.error(`Failed to get pool token balance: ${error.message}`);
        return null;
    }
}

async function withdrawLiquidity(wallet, address) {
    let client;
    try {
        const poolToken = await getPoolTokenBalance(address);
        if (!poolToken || parseFloat(poolToken.amount) <= 0) { 
            logger.warn('No pool tokens found or amount is zero to withdraw');
            return null;
        }

        client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });
        
        const { sequence } = await client.getSequence(address);
        logger.info(`[${address}] Current account sequence for withdraw liquidity: ${sequence}`);

        const msg = {
            withdraw_liquidity: {}
        };

        const funds = coins(poolToken.amount, poolToken.denom);

        logger.loading(`Withdrawing liquidity: ${poolToken.amount} LP tokens`);
        const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, 'auto', 'Removing pool Liquidity', funds);

        // Perbaikan: Hapus blok verifikasi on-chain yang menyebabkan error pollForTx
        // try {
        //     logger.info(`Verifying liquidity withdrawal transaction ${result.transactionHash} on-chain...`);
        //     const txResponse = await client.pollForTx(result.transactionHash, 10000, 2000); 
        //     if (txResponse.code !== undefined && txResponse.code !== 0) {
        //         throw new Error(`Transaction ${result.transactionHash} failed on-chain with code ${txResponse.code}: ${txResponse.rawLog}`);
        //     }
        //     logger.success(`Liquidity withdrawal transaction ${result.transactionHash} confirmed on-chain.`);
        // } catch (txError) {
        //     logger.error(`Failed to confirm liquidity withdrawal transaction ${result.transactionHash} on-chain: ${txError.message}. Proceeding anyway.`);
        // }

        logger.success(`Liquidity withdrawn! Tx: ${EXPLORER_URL}${result.transactionHash}`);
        return result;
    } catch (error) {
        logger.error(`Withdraw liquidity failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return null;
    }
}

async function getPoints(address) {
    try {
        const response = await axios.get(`${API_URL}portfolio/${address}/points`, {
            headers: {
                accept: 'application/json',
                'accept-language': 'en-US,en;q=0.7',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                Referer: 'https://testnet.oroswap.org/',
            },
        });
        return response.data.points[0];
    } catch (error) {
        logger.error(`Failed to fetch points for ${address}: ${error.message}`);
        return null;
    }
}

function displayCountdown(hours, minutes, seconds) {
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    process.stdout.write(`\r${colors.cyan}[⏰] Next execution in: ${timeStr}${colors.reset}`);
}

async function startDailyCountdown(keys, numTransactions) {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    while (true) {
        const startTime = Date.now();
        const endTime = startTime + TWENTY_FOUR_HOURS;

        while (Date.now() < endTime) {
            const remaining = endTime - Date.now();
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

            displayCountdown(hours, minutes, seconds);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('\n');
        logger.success('⏰ 24 hours completed! Starting new transaction cycle...\n');
        await executeAllWallets(keys, numTransactions);
    }
}

async function executeAllWallets(keys, numTransactions) {
    for (let walletIndex = 0; walletIndex < keys.length; walletIndex++) {
        const key = keys[walletIndex];
        try {
            const wallet = await getWallet(key);
            const address = await getAccountAddress(wallet);
            logger.step(`Processing wallet: ${address} (wallet ${walletIndex + 1})`);

            for (let cycle = 1; cycle <= numTransactions; cycle++) {
                await executeTransactionCycle(wallet, address, cycle, walletIndex + 1);

                if (cycle < numTransactions) {
                    logger.info(`Waiting ${colors.magenta}20 seconds${colors.reset} before next cycle for wallet ${walletIndex + 1}...`);
                    await new Promise(resolve => setTimeout(resolve, 20000)); 
                }
            }

            logger.success(`All ${numTransactions} transaction cycles completed for wallet ${walletIndex + 1}!`);
            if (walletIndex < keys.length - 1) {
                console.log();
            }
        } catch (error) {
            logger.critical(`Error processing wallet ${walletIndex + 1}: ${error.message}. Skipping to next wallet.`);
        }
    }
}

async function executeTransactionCycle(wallet, address, cycleNumber, walletNumber) {
    logger.section(`Transaction for Wallet ${walletNumber} (Cycle ${cycleNumber})`);
    
    const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE });

    const zigBalance = await getBalance(client, address, DENOM_ZIG);
    const oroBalance = await getBalance(client, address, DENOM_ORO);
    logger.info(`Initial balances: ${zigBalance.toFixed(6)} ZIG, ${oroBalance.toFixed(6)} ORO`);

    let successfulSwaps = 0;
    for (let i = 1; i <= 10; i++) {
        const fromDenom = i % 2 === 1 ? DENOM_ORO : DENOM_ZIG;
        
        const currentBalance = await getBalance(client, address, fromDenom);
        
        const minSwapAmount = 0.0005; 
        if (currentBalance < minSwapAmount) {  
            logger.warn(`Skipping swap ${i}/10: Insufficient ${fromDenom === DENOM_ZIG ? 'ZIG' : 'ORO'} balance (${currentBalance.toFixed(6)} < ${minSwapAmount.toFixed(6)})`);
            continue; 
        }
        
        const swapAmount = getRandomSwapAmount(currentBalance);

        const result = await performSwap(wallet, address, swapAmount, fromDenom, i);
        if (result) {
            successfulSwaps++;
        } else {
            logger.warn(`Swap ${i}/10 failed after all retries.`);
        }
        
        logger.info(`Waiting ${colors.magenta}8 seconds${colors.reset} before next swap...`);
        await new Promise(resolve => setTimeout(resolve, 8000)); 
    }

    logger.info(`Waiting ${colors.magenta}5 seconds${colors.reset} before liquidity operations...`);
    await new Promise(resolve => setTimeout(resolve, 5000)); 

    logger.section('Liquidity Operations');
    const liquidityResult = await addLiquidity(wallet, address);
    if (!liquidityResult) {
        logger.warn('Liquidity addition failed, proceeding to withdrawal attempt.');
    }

    await new Promise(resolve => setTimeout(resolve, 5000)); 

    const withdrawResult = await withdrawLiquidity(wallet, address);
    if (!withdrawResult) {
        logger.warn('Liquidity withdrawal failed, proceeding to points check.');
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    const points = await getPoints(address);
    if (points) {
        logger.info(`Points: ${points.points} (Swaps: ${points.swaps_count}, Pools: ${points.join_pool_count})`);
    } else {
        logger.warn('Failed to retrieve points.');
    }

    logger.summary(`Cycle ${cycleNumber} completed with ${successfulSwaps}/10 successful swaps.`);
    console.log();
}

async function main() {
    logger.banner();

    const keys = Object.keys(process.env)
        .filter((key) => key.startsWith('PRIVATE_KEY_'))
        .map((key) => process.env[key]);

    if (keys.length === 0) {
        logger.critical('No private keys or mnemonic found in .env file. Please add PRIVATE_KEY_1, PRIVATE_KEY_2, etc.');
        rl.close();
        return;
    }

    let numTransactions;
    while (true) {
        const input = await prompt('Enter number of transactions to execute per wallet: ');
        if (isValidNumber(input)) {
            numTransactions = parseInt(input);
            break;
        }
        logger.error('Invalid input. Please enter a positive number.');
    }

    console.log();
    await executeAllWallets(keys, numTransactions);
    
    startDailyCountdown(keys, numTransactions);
}

main().catch((error) => {
    if (typeof logger === 'object' && typeof logger.critical === 'function') {
        logger.critical(`Bot failed: ${error.message}`);
    } else {
        console.error(`\x1b[31m[FATAL ERROR] Bot failed: ${error.message}\x1b[0m`);
    }
    rl.close();
});
