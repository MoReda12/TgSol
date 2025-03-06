import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } from '@solana/spl-token';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import axios from 'axios';
import * as fs from 'fs';
import input from 'input'; // For interactive authentication
import { NewMessageEvent } from 'telegram/events/NewMessage';

dotenv.config();

const RAYDIUM_POOL_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const JUPITER_API_ENDPOINT = 'https://quote-api.jup.ag/v6';
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

const JITO_API_URL = 'https://jito-api.solana.com';
const BUNDLE_EXECUTOR_PROGRAM_ID = new PublicKey('JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph');

type TokenInfo = {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    boughtAmount: number;
    boughtPrice: number;
    boughtTimestamp: number;
    txId: string;
    sourceChannel: string;
};

type Config = {
    minLiquidity: number;
    maxMcap: number;
    maxBuyAmount: number;
    slippage: number;
    jitoTip: number;
    autoSellProfit: number;
    autoSellLoss: number;
    monitorDuration: number;
    blacklistedTokens: string[];
    whitelistedCreators: string[];
    priorityChannels: string[];
    telegramChannels: string[];
};

class SolanaSniper {
    private connection: Connection;
    private wallet: Keypair;
    private telegramClient: TelegramClient;
    private config: Config;
    private tokensTracked: Map<string, TokenInfo> = new Map();
    private processedMessages: Set<string> = new Set();
    private lastProcessedTimestamps: Map<string, number> = new Map();

    constructor() {
        this.initializeConnection();
        this.initializeWallet();
        this.loadConfig();
    }

    private initializeConnection() {
        const rpcUrl = process.env.RPC_URL || 'https://api.helius.xyz/v1/your-api-key';
        this.connection = new Connection(rpcUrl, 'confirmed');
        console.log('Connected to Solana network');
    }

    private initializeWallet() {
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('Private key not found in environment variables');
        }
        
        try {
            const decodedKey = bs58.decode(privateKey);
            this.wallet = Keypair.fromSecretKey(decodedKey);
            console.log(`Wallet initialized: ${this.wallet.publicKey.toString()}`);
        } catch (error) {
            throw new Error(`Failed to initialize wallet: ${error}`);
        }
    }

    private loadConfig() {
        try {
            this.config = {
                minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || '1'),
                maxMcap: parseFloat(process.env.MAX_MCAP || '1000000'),
                maxBuyAmount: parseFloat(process.env.MAX_BUY_AMOUNT || '0.1'),
                slippage: parseFloat(process.env.SLIPPAGE || '5'),
                jitoTip: parseFloat(process.env.JITO_TIP || '0.005'),
                autoSellProfit: parseFloat(process.env.AUTO_SELL_PROFIT || '20'),
                autoSellLoss: parseFloat(process.env.AUTO_SELL_LOSS || '10'),
                monitorDuration: parseInt(process.env.MONITOR_DURATION || '3600', 10),
                blacklistedTokens: (process.env.BLACKLISTED_TOKENS || '').split(',').filter(Boolean),
                whitelistedCreators: (process.env.WHITELISTED_CREATORS || '').split(',').filter(Boolean),
                priorityChannels: (process.env.PRIORITY_CHANNELS || '').split(',').filter(Boolean),
                telegramChannels: (process.env.TELEGRAM_CHANNELS || '').split(',').filter(Boolean),
            };
            console.log('Configuration loaded');
            console.log('Monitoring Telegram channels:', this.config.telegramChannels);
            console.log('Priority channels:', this.config.priorityChannels);
        } catch (error) {
            throw new Error(`Failed to load configuration: ${error}`);
        }
    }

    private async initializeTelegramClient() {
        // Get telegram API credentials from env
        const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
        const apiHash = process.env.TELEGRAM_API_HASH || '';
        const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER || '';
        
        if (!apiId || !apiHash || !phoneNumber) {
            throw new Error('Telegram API credentials not found in environment variables');
        }
        
        // Create session from stored string or create new one
        let stringSession: StringSession;
        if (fs.existsSync('telegram_session.txt')) {
            const sessionString = fs.readFileSync('telegram_session.txt', 'utf8');
            stringSession = new StringSession(sessionString);
            console.log('Loaded existing Telegram session');
        } else {
            stringSession = new StringSession('');
            console.log('Creating new Telegram session');
        }
        
        try {
            // Initialize the client
            this.telegramClient = new TelegramClient(stringSession, apiId, apiHash, {
                connectionRetries: 5,
            });
            
            console.log('Connecting to Telegram...');
            await this.telegramClient.start({
                phoneNumber: async () => phoneNumber,
                password: async () => await input.text('Please enter your password: '),
                phoneCode: async () => await input.text('Please enter the code you received: '),
                onError: (err) => console.log(err),
            });
            console.log('Connected to Telegram as a user');
            
            // Save the session for future use
            const sessionString = this.telegramClient.session.save();
            fs.writeFileSync('telegram_session.txt', sessionString);
            console.log('Telegram session saved');
            
            return true;
        } catch (error) {
            console.error('Failed to initialize Telegram client:', error);
            throw error;
        }
    }

    public async start() {
        try {
            console.log('Starting Solana memecoin sniper bot...');
            
            await this.checkWalletBalance();
            await this.initializeTelegramClient();
            await this.startTelegramListener();
            this.startTokenMonitoring();
            
            console.log('Bot is running. Monitoring Telegram channels for new tokens...');
        } catch (error) {
            console.error('Failed to start bot:', error);
        }
    }

    private async checkWalletBalance() {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / LAMPORTS_PER_SOL;
            
            console.log(`Wallet balance: ${solBalance} SOL`);
            
            if (solBalance < this.config.maxBuyAmount + this.config.jitoTip) {
                console.warn(`Low balance warning: ${solBalance} SOL is less than configured buy amount plus Jito tip`);
            }
        } catch (error) {
            console.error('Failed to check wallet balance:', error);
        }
    }

    private async startTelegramListener() {
        if (this.config.telegramChannels.length === 0) {
            throw new Error('No Telegram channels specified in configuration');
        }

        try {
            // Convert channel IDs to BigInt for Telegram API
            const channelIds = [...this.config.telegramChannels, ...this.config.priorityChannels].map(id => BigInt(id));
            
            // Get info about all the channels
            for (const channelId of channelIds) {
                try {
                    const entity = await this.telegramClient.getEntity(channelId);
                    console.log(`Successfully connected to channel: ${entity.id}`);
                } catch (err) {
                    console.warn(`Could not get info for channel ${channelId}: ${err}`);
                }
            }
            
            // Setup event handler for new messages
            this.telegramClient.addEventHandler(this.handleNewMessage.bind(this), new NewMessage({}));
            
            console.log('Telegram listener started successfully');
        } catch (error) {
            console.error('Failed to start Telegram listener:', error);
            throw error;
        }
    }
    
    private async handleNewMessage(event: NewMessageEvent) {
        try {
            const message = event.message;
            
            // Check if message is from a channel we're monitoring
            if (!message.chatId) return;
            
            const channelId = message.chatId.toString();
            
            if (!this.config.telegramChannels.includes(channelId) && 
                !this.config.priorityChannels.includes(channelId)) {
                return;
            }
            
            const messageId = message.id;
            const messageText = message.text || '';
            
            console.log(`Received message from channel ${channelId}, msg ID: ${messageId}`);
            console.log(`Message content: ${messageText}`);
            
            const fullMessageId = `${channelId}:${messageId}`;
            if (this.processedMessages.has(fullMessageId)) {
                console.log(`Message ${fullMessageId} already processed. Skipping.`);
                return;
            }
            
            this.processedMessages.add(fullMessageId);
            await this.processMessage(messageText, channelId);
            
        } catch (error) {
            console.error('Error handling Telegram message:', error);
        }
    }

    private async processMessage(message: string, channelId: string) {
        const now = Date.now();
        const lastProcessed = this.lastProcessedTimestamps.get(channelId) || 0;
        
        if (now - lastProcessed < 500) {
            console.log(`Rate limiting channel ${channelId}. Last processed ${now - lastProcessed}ms ago.`);
            return;
        }
        
        this.lastProcessedTimestamps.set(channelId, now);
        
        try {
            console.log(`Processing message from channel ${channelId}`);
            const tokenAddresses = this.extractTokenAddresses(message);
            
            console.log(`Extracted token addresses:`, tokenAddresses);
            
            if (tokenAddresses.length === 0) {
                console.log(`No valid token addresses found in the message.`);
                return;
            }
            
            console.log(`Found ${tokenAddresses.length} potential token addresses in channel ${channelId}`);
            
            for (const address of tokenAddresses) {
                if (this.tokensTracked.has(address)) {
                    console.log(`Token ${address} is already being tracked. Skipping.`);
                    continue;
                }
                
                if (this.config.blacklistedTokens.includes(address)) {
                    console.log(`Skipping blacklisted token: ${address}`);
                    continue;
                }
                
                console.log(`Starting analysis for token ${address} from channel ${channelId}`);
                setTimeout(() => this.analyzeAndBuyToken(address, channelId), 0);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    }

    private extractTokenAddresses(message: string): string[] {
        const addresses: string[] = [];
        
        console.log('Extracting token addresses from message:', message);
        
        const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
        const matches = message.match(solanaAddressRegex) || [];
        
        console.log('Regex matches:', matches);
        
        for (const match of matches) {
            try {
                console.log(`Validating potential address: ${match}`);
                new PublicKey(match);
                addresses.push(match);
                console.log(`Valid Solana address found: ${match}`);
            } catch (error) {
                console.log(`Invalid Solana address: ${match}`);
                continue;
            }
        }
        
        return addresses;
    }

    // The rest of the methods (analyzeAndBuyToken, isValidTokenAddress, etc.) remain the same
    // as they are unrelated to the Telegram client implementation
    
    private async analyzeAndBuyToken(tokenAddress: string, channelId: string) {
        try {
            console.log(`Analyzing token: ${tokenAddress}`);
            
            if (!this.isValidTokenAddress(tokenAddress)) {
                console.log(`Invalid token address: ${tokenAddress}`);
                return;
            }
            
            const tokenInfo = await this.getTokenInfo(tokenAddress);
            if (!tokenInfo) {
                console.log(`Could not retrieve token info for: ${tokenAddress}`);
                return;
            }
            
            const isPumpFunToken = await this.isPumpFunToken(tokenAddress);
            const isRaydiumToken = await this.isRaydiumToken(tokenAddress);
            
            console.log(`Token ${tokenAddress} check - pump.fun: ${isPumpFunToken}, Raydium: ${isRaydiumToken}`);
            
            if (!isPumpFunToken && !isRaydiumToken) {
                console.log(`Token ${tokenAddress} is not listed on Raydium or pump.fun`);
                return;
            }
            
            console.log(`Token ${tokenAddress} (${tokenInfo.symbol}) found on ${isPumpFunToken ? 'pump.fun' : 'Raydium'}`);
            
            const liquidity = await this.getTokenLiquidity(tokenAddress);
            console.log(`Token ${tokenAddress} liquidity: ${liquidity} SOL`);
            
            if (liquidity < this.config.minLiquidity) {
                console.log(`Token ${tokenAddress} has insufficient liquidity: ${liquidity} SOL (min: ${this.config.minLiquidity})`);
                return;
            }
            
            const mcap = await this.getTokenMarketCap(tokenAddress);
            console.log(`Token ${tokenAddress} market cap: ${mcap}`);
            
            if (mcap > this.config.maxMcap) {
                console.log(`Token ${tokenAddress} market cap too high: ${mcap} (max: ${this.config.maxMcap})`);
                return;
            }
            
            const isPriority = this.config.priorityChannels.includes(channelId);
            const buyAmount = isPriority ? 
                this.config.maxBuyAmount : 
                Math.min(this.config.maxBuyAmount, liquidity * 0.02);
            
            console.log(`Buying token ${tokenAddress} with ${buyAmount} SOL (priority channel: ${isPriority})`);
            await this.buyToken(tokenAddress, tokenInfo, buyAmount, channelId);
            
        } catch (error) {
            console.error(`Error analyzing token ${tokenAddress}:`, error);
        }
    }

    private isValidTokenAddress(address: string): boolean {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    private async getTokenInfo(tokenAddress: string): Promise<any> {
        try {
            const tokenPublicKey = new PublicKey(tokenAddress);
            const accountInfo = await this.connection.getAccountInfo(tokenPublicKey);
            
            if (!accountInfo || accountInfo.owner.toString() !== TOKEN_PROGRAM_ID.toString()) {
                console.log(`Token ${tokenAddress} is not an SPL token`);
                return null;
            }
            
            console.log(`Fetching token info from Helius API for ${tokenAddress}`);
            const response = await axios.get(`https://api.helius.xyz/v0/tokens/${tokenAddress}?api-key=${process.env.HELIUS_API_KEY}`);
            
            if (!response.data) {
                console.log(`No data returned from Helius API for ${tokenAddress}`);
                return null;
            }
            
            console.log(`Token info retrieved: ${response.data.name} (${response.data.symbol})`);
            return {
                address: tokenAddress,
                name: response.data.name || 'Unknown',
                symbol: response.data.symbol || 'UNKNOWN',
                decimals: response.data.decimals || 9,
            };
        } catch (error) {
            console.error(`Error getting token info for ${tokenAddress}:`, error);
            return null;
        }
    }

    private async isPumpFunToken(tokenAddress: string): Promise<boolean> {
        try {
            console.log(`Checking if ${tokenAddress} is listed on pump.fun`);
            const response = await axios.get(`https://api.pump.fun/v1/token/${tokenAddress}`);
            const isListed = !!response.data;
            console.log(`Token ${tokenAddress} pump.fun check: ${isListed}`);
            return isListed;
        } catch (error) {
            console.log(`Token ${tokenAddress} not found on pump.fun:`, error.message);
            return false;
        }
    }

    private async isRaydiumToken(tokenAddress: string): Promise<boolean> {
        try {
            console.log(`Checking if ${tokenAddress} is listed on Raydium`);
            const response = await axios.get(`https://api.raydium.io/v2/sdk/token/raydium.mainnet.json`);
            const tokens = response.data.tokens || [];
            const isListed = tokens.some((token: any) => token.mint === tokenAddress);
            console.log(`Token ${tokenAddress} Raydium check: ${isListed}`);
            return isListed;
        } catch (error) {
            console.log(`Error checking Raydium listing for ${tokenAddress}:`, error.message);
            return false;
        }
    }

    private async getTokenLiquidity(tokenAddress: string): Promise<number> {
        try {
            console.log(`Checking liquidity for ${tokenAddress} via Jupiter API`);
            const routeMap = await axios.get(`${JUPITER_API_ENDPOINT}/quote?inputMint=${tokenAddress}&outputMint=${SOL_ADDRESS}&amount=1000000&slippage=0.5`);
            
            if (!routeMap.data || !routeMap.data.outAmount) {
                console.log(`No liquidity data available for ${tokenAddress}`);
                return 0;
            }
            
            const liquidity = routeMap.data.outAmount / LAMPORTS_PER_SOL;
            console.log(`Token ${tokenAddress} liquidity: ${liquidity} SOL`);
            return liquidity;
        } catch (error) {
            console.log(`Error checking liquidity for ${tokenAddress}:`, error.message);
            return 0;
        }
    }

    private async getTokenMarketCap(tokenAddress: string): Promise<number> {
        try {
            console.log(`Checking market cap for ${tokenAddress} via Helius API`);
            const response = await axios.get(`https://api.helius.xyz/v0/tokens/${tokenAddress}?api-key=${process.env.HELIUS_API_KEY}`);
            
            if (!response.data || !response.data.marketCap) {
                console.log(`No market cap data available for ${tokenAddress}`);
                return 0;
            }
            
            console.log(`Token ${tokenAddress} market cap: ${response.data.marketCap}`);
            return response.data.marketCap;
        } catch (error) {
            console.log(`Error checking market cap for ${tokenAddress}:`, error.message);
            return 0;
        }
    }

    private async buyToken(tokenAddress: string, tokenInfo: any, buyAmount: number, channelId: string) {
        try {
            console.log(`Attempting to buy ${buyAmount} SOL of ${tokenInfo.symbol} (${tokenAddress})`);
            
            const amountLamports = buyAmount * LAMPORTS_PER_SOL;
            const slippage = this.config.slippage / 100;
            
            console.log(`Getting Jupiter quote for ${tokenAddress}`);
            const quote = await axios.get(
                `${JUPITER_API_ENDPOINT}/quote?inputMint=${SOL_ADDRESS}&outputMint=${tokenAddress}&amount=${amountLamports}&slippage=${slippage}`
            );
            
            if (!quote.data || !quote.data.outAmount) {
                console.log(`Could not get quote for ${tokenAddress}`);
                return;
            }
            
            console.log(`Creating swap transaction for ${tokenAddress}`);
            const swapRoute = await axios.post(`${JUPITER_API_ENDPOINT}/swap`, {
                route: quote.data,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapUnwrapSOL: true
            });
            
            if (!swapRoute.data || !swapRoute.data.swapTransaction) {
                console.log(`Could not create swap transaction for ${tokenAddress}`);
                return;
            }
            
            const swapTransactionBuf = Buffer.from(swapRoute.data.swapTransaction, 'base64');
            let transaction = Transaction.from(swapTransactionBuf);
            
            const jitoTipLamports = this.config.jitoTip * LAMPORTS_PER_SOL;
            const tipInstruction = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: new PublicKey(BUNDLE_EXECUTOR_PROGRAM_ID),
                lamports: jitoTipLamports
            });
            
            transaction.add(tipInstruction);
            
            console.log(`Sending transaction to purchase ${tokenAddress}`);
            const txId = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [this.wallet],
                { skipPreflight: true, maxRetries: 3 }
            );
            
            console.log(`Successfully bought ${tokenInfo.symbol}: ${txId}`);
            
            const tokenInfo2: TokenInfo = {
                address: tokenAddress,
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
                decimals: tokenInfo.decimals,
                boughtAmount: quote.data.outAmount,
                boughtPrice: buyAmount,
                boughtTimestamp: Date.now(),
                txId: txId,
                sourceChannel: channelId
            };
            
            this.tokensTracked.set(tokenAddress, tokenInfo2);
            this.saveTransaction(tokenInfo2);
            
            setTimeout(() => this.monitorTokenPrice(tokenAddress), 5000);
            
        } catch (error) {
            console.error(`Error buying token ${tokenAddress}:`, error);
        }
    }

    private saveTransaction(tokenInfo: TokenInfo) {
        try {
            const txData = {
                ...tokenInfo,
                walletAddress: this.wallet.publicKey.toString(),
                timestamp: new Date().toISOString()
            };
            
            let transactions = [];
            
            if (fs.existsSync('transactions.json')) {
                const data = fs.readFileSync('transactions.json', 'utf8');
                transactions = JSON.parse(data);
            }
            
            transactions.push(txData);
            fs.writeFileSync('transactions.json', JSON.stringify(transactions, null, 2));
            console.log(`Transaction saved for ${tokenInfo.symbol}`);
            
        } catch (error) {
            console.error('Error saving transaction:', error);
        }
    }

    private startTokenMonitoring() {
        setInterval(() => {
            this.tokensTracked.forEach((tokenInfo, address) => {
                const elapsedTime = Date.now() - tokenInfo.boughtTimestamp;
                
                if (elapsedTime > this.config.monitorDuration * 1000) {
                    console.log(`Monitor timeout for ${tokenInfo.symbol}. Selling...`);
                    this.sellToken(address, 'monitor_timeout');
                }
            });
        }, 30000);
    }

    private async monitorTokenPrice(tokenAddress: string) {
        const tokenInfo = this.tokensTracked.get(tokenAddress);
        if (!tokenInfo) return;
        
        try {
            const currentValue = await this.getTokenValue(tokenAddress, tokenInfo.boughtAmount);
            const profitLoss = ((currentValue - tokenInfo.boughtPrice) / tokenInfo.boughtPrice) * 100;
            
            console.log(`${tokenInfo.symbol} current P/L: ${profitLoss.toFixed(2)}%`);
            
            if (profitLoss >= this.config.autoSellProfit) {
                console.log(`${tokenInfo.symbol} reached profit target (${profitLoss.toFixed(2)}%). Selling...`);
                await this.sellToken(tokenAddress, 'take_profit');
            } else if (profitLoss <= -this.config.autoSellLoss) {
                console.log(`${tokenInfo.symbol} reached stop loss (${profitLoss.toFixed(2)}%). Selling...`);
                await this.sellToken(tokenAddress, 'stop_loss');
            } else {
                setTimeout(() => this.monitorTokenPrice(tokenAddress), 10000);
            }
            
        } catch (error) {
            console.error(`Error monitoring token ${tokenAddress}:`, error);
            setTimeout(() => this.monitorTokenPrice(tokenAddress), 30000);
        }
    }

    private async getTokenValue(tokenAddress: string, amount: number): Promise<number> {
        try {
            const quote = await axios.get(
                `${JUPITER_API_ENDPOINT}/quote?inputMint=${tokenAddress}&outputMint=${SOL_ADDRESS}&amount=${amount}`
            );
            
            if (!quote.data || !quote.data.outAmount) {
                return 0;
            }
            
            return quote.data.outAmount / LAMPORTS_PER_SOL;
            
        } catch (error) {
            console.error(`Error getting token value for ${tokenAddress}:`, error);
            return 0;
        }
    }

    private async sellToken(tokenAddress: string, reason: string) {
        const tokenInfo = this.tokensTracked.get(tokenAddress);
        if (!tokenInfo) return;
        
        try {
            console.log(`Selling ${tokenInfo.symbol} (${tokenAddress}) - Reason: ${reason}`);
            
            const quote = await axios.get(
                `${JUPITER_API_ENDPOINT}/quote?inputMint=${tokenAddress}&outputMint=${SOL_ADDRESS}&amount=${tokenInfo.boughtAmount}&slippage=${this.config.slippage/100}`
            );
            
            if (!quote.data) {
                console.log(`Could not get quote for selling ${tokenAddress}`);
                return;
            }
            
            const swapRoute = await axios.post(`${JUPITER_API_ENDPOINT}/swap`, {
                route: quote.data,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapUnwrapSOL: true
            });
            
            if (!swapRoute.data || !swapRoute.data.swapTransaction) {
                console.log(`Could not create swap transaction for selling ${tokenAddress}`);
                return;
            }
            
            const swapTransactionBuf = Buffer.from(swapRoute.data.swapTransaction, 'base64');
            let transaction = Transaction.from(swapTransactionBuf);
            
            const jitoTipLamports = this.config.jitoTip * LAMPORTS_PER_SOL;
            const tipInstruction = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: new PublicKey(BUNDLE_EXECUTOR_PROGRAM_ID),
                lamports: jitoTipLamports
            });
            
            transaction.add(tipInstruction);
            
            const txId = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [this.wallet],
                { skipPreflight: true, maxRetries: 3 }
            );
            
            const soldAmount = quote.data.outAmount / LAMPORTS_PER_SOL;
            const profitLoss = soldAmount - tokenInfo.boughtPrice;
            const profitLossPercentage = (profitLoss / tokenInfo.boughtPrice) * 100;
            
            console.log(`Successfully sold ${tokenInfo.symbol} for ${soldAmount} SOL (${profitLossPercentage.toFixed(2)}% P/L): ${txId}`);
            
            this.saveSellTransaction(tokenInfo, soldAmount, txId, reason, profitLossPercentage);
            this.tokensTracked.delete(tokenAddress);
            
        } catch (error) {
            console.error(`Error selling token ${tokenAddress}:`, error);
        }
    }

    private saveSellTransaction(tokenInfo: TokenInfo, soldAmount: number, txId: string, reason: string, profitLossPercentage: number) {
        try {
            const txData = {
                address: tokenInfo.address,
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
                boughtAmount: tokenInfo.boughtAmount,
                boughtPrice: tokenInfo.boughtPrice,
                boughtTimestamp: tokenInfo.boughtTimestamp,
                boughtTxId: tokenInfo.txId,
                soldAmount: soldAmount,
                soldTimestamp: Date.now(),
                soldTxId: txId,
                reason: reason,
                profitLoss: profitLossPercentage,
                sourceChannel: tokenInfo.sourceChannel,
                walletAddress: this.wallet.publicKey.toString()
            };
            
            let transactions = [];
            
            if (fs.existsSync('sold_transactions.json')) {
                const data = fs.readFileSync('sold_transactions.json', 'utf8');
                transactions = JSON.parse(data);
            }
            
            transactions.push(txData);
            fs.writeFileSync('sold_transactions.json', JSON.stringify(transactions, null, 2));
            console.log(`Sell transaction saved for ${tokenInfo.symbol}`);
            
        } catch (error) {
            console.error('Error saving sell transaction:', error);
        }
    }
}

const solanaSniper = new SolanaSniper();
solanaSniper.start();