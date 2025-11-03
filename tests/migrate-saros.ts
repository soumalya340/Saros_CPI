import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MigrateSaros } from "../target/types/migrate_saros";

import {
  Keypair,
  PublicKey,
  Connection,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  NATIVE_MINT,
  createSyncNativeInstruction,
  transfer,
} from "@solana/spl-token";
import { assert } from "chai";

describe("migrate-saros: Initialize Pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MigrateSaros as Program<MigrateSaros>;
  const payer = provider.wallet as anchor.Wallet;

  // Pool configuration
  const TRADE_FEE_NUMERATOR = new BN(25); // 0.25% trading fee
  const TRADE_FEE_DENOMINATOR = new BN(10000);
  const OWNER_TRADE_FEE_NUMERATOR = new BN(5); // 0.05% protocol fee
  const OWNER_TRADE_FEE_DENOMINATOR = new BN(10000);
  const OWNER_WITHDRAW_FEE_NUMERATOR = new BN(0);
  const OWNER_WITHDRAW_FEE_DENOMINATOR = new BN(0);
  const HOST_FEE_NUMERATOR = new BN(20);
  const HOST_FEE_DENOMINATOR = new BN(100);
  const CURVE_TYPE = 0; // Constant product
  const CURVE_PARAMETERS = Buffer.alloc(32); // 32-byte buffer for swap_calculator parameter

  const sarosProgram = new PublicKey("SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr");

  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let poolAccount: Keypair;
  let poolAuthority: PublicKey;
  let poolLpMint: Keypair;
  let tokenAVault: PublicKey;
  let tokenBVault: PublicKey;
  let feeAccount: PublicKey;
  let userLpAccount: PublicKey;
  let userTokenAAccount: PublicKey;
  let userTokenBAccount: PublicKey;

  // Initial liquidity amounts
  const INITIAL_TOKEN_A_AMOUNT = 10 * LAMPORTS_PER_SOL; // 10 SOL
  const INITIAL_TOKEN_B_AMOUNT = 10000 * LAMPORTS_PER_SOL; // 10,000 Token B

  async function wrapSol(
    connection: Connection,
    wallet: Keypair,
    amountInSol: number
  ): Promise<PublicKey> {
    const associatedTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      NATIVE_MINT,
      wallet.publicKey
    );
    
    if (amountInSol > 0) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: associatedTokenAccount.address,
          lamports: amountInSol * LAMPORTS_PER_SOL,
        }),
        createSyncNativeInstruction(associatedTokenAccount.address)
      );
  
      await sendAndConfirmTransaction(connection, tx, [wallet]);
    }
  
    return associatedTokenAccount.address;
  }

  before(async () => {
    console.log("\n🔧 Setting up test environment...\n");

    // ==========================================
    // STEP 1: Set up Token Mints
    // ==========================================
    console.log("1. Setting up tokens...");
    
    tokenAMint = NATIVE_MINT;
    console.log(`Token A (WSOL): ${tokenAMint.toString()}`);

    console.log("2. Creating Token B mint...");
    tokenBMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      9
    );
    console.log(`Token B: ${tokenBMint.toString()}`);

    // Ensure token A < token B (Saros convention)
    if (tokenAMint.toBuffer().compare(tokenBMint.toBuffer()) > 0) {
      [tokenAMint, tokenBMint] = [tokenBMint, tokenAMint];
      console.log("⚠️ Swapped token order to maintain A < B convention");
    }

    // ==========================================
    // STEP 2: Create User Token Accounts
    // ==========================================
    console.log("\n3. Creating user token accounts...");
    
    const wsolAmount = 20; // 20 SOL total
    userTokenAAccount = await wrapSol(provider.connection, payer.payer, wsolAmount);
    console.log(`User WSOL Account: ${userTokenAAccount.toString()}`);
    
    const tokenBAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenBMint,
      payer.publicKey
    );
    userTokenBAccount = tokenBAccountInfo.address;
    console.log(`User Token B Account: ${userTokenBAccount.toString()}`);

    const amountToMint = 20000; // 20,000 tokens
    await mintTo(
      provider.connection,
      payer.payer,
      tokenBMint,
      userTokenBAccount,
      payer.publicKey,
      amountToMint * LAMPORTS_PER_SOL
    );
    console.log(`Minted ${amountToMint} Token B to user`);
  });

  it("Initializes a Saros pool", async () => {
    console.log("\n📊 Initializing Saros Pool...\n");

    // ==========================================
    // STEP 1: Create Pool Account (Simple Keypair!) 🔑
    // ==========================================
    console.log("1. Creating Pool Account (Regular Keypair)");
    
    // IMPORTANT: Just generate a regular keypair for the pool!
    poolAccount = Keypair.generate();
    console.log(`   Pool Account: ${poolAccount.publicKey.toString()}`);

    // ==========================================
    // STEP 2: Derive Pool Authority from Pool Account
    // ==========================================
    console.log("\n2. Deriving Pool Authority (PDA)");
    
    // This IS a PDA, derived from the pool account using Saros program
    [poolAuthority] = PublicKey.findProgramAddressSync(
      [poolAccount.publicKey.toBuffer()],
      sarosProgram
    );
    console.log(`   Pool Authority: ${poolAuthority.toString()}`);

    // ==========================================
    // STEP 3: Create LP Mint from Authority bytes
    // ==========================================
    console.log("\n3. Creating LP Mint from Authority");
    
    // Create deterministic keypair from authority bytes
    poolLpMint = Keypair.fromSeed(poolAuthority.toBuffer().slice(0, 32));
    console.log(`   LP Mint: ${poolLpMint.publicKey.toString()}`);

    // Create the mint using the deterministic keypair
    await createMint(
      provider.connection,
      payer.payer,
      poolAuthority, // Mint authority is the pool authority
      null, // No freeze authority
      9, // 9 decimals
      poolLpMint // Use our deterministic keypair
    );
    console.log(`LP Mint created`);
    // ==========================================
    // STEP 4: Create Pool Token Vaults
    // ==========================================
    console.log("\n4. Creating pool token vaults");

    // Create pool's Token A vault
    const tokenAVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenAMint,
      poolAuthority,
      true // Allow owner off curve for PDA
    );
    tokenAVault = tokenAVaultAccount.address;
    console.log(`   Token A Vault: ${tokenAVault.toString()}`);

    // Create pool's Token B vault
    const tokenBVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenBMint,
      poolAuthority,
      true // Allow owner off curve for PDA
    );
    tokenBVault = tokenBVaultAccount.address;
    console.log(`   Token B Vault: ${tokenBVault.toString()}`);

    // ==========================================
    // STEP 5: Transfer initial liquidity
    // ==========================================
    console.log("\n5. Transferring initial liquidity to vaults");

    await transfer(
      provider.connection,
      payer.payer,
      userTokenAAccount,
      tokenAVault,
      payer.publicKey,
      INITIAL_TOKEN_A_AMOUNT
    );
    console.log(`   Transferred ${INITIAL_TOKEN_A_AMOUNT / LAMPORTS_PER_SOL} SOL`);

    await transfer(
      provider.connection,
      payer.payer,
      userTokenBAccount,
      tokenBVault,
      payer.publicKey,
      INITIAL_TOKEN_B_AMOUNT
    );
    console.log(`   Transferred ${INITIAL_TOKEN_B_AMOUNT / LAMPORTS_PER_SOL} Token B`);

    // ==========================================
    // STEP 6: Derive Fee and LP Accounts
    // ==========================================
    console.log("\n6. Setting up fee and LP accounts");
    
    feeAccount = anchor.utils.token.associatedAddress({
      mint: poolLpMint.publicKey,
      owner: payer.publicKey,
    });
    console.log(`   Fee Account: ${feeAccount.toString()}`);

    userLpAccount = anchor.utils.token.associatedAddress({
      mint: poolLpMint.publicKey,
      owner: payer.publicKey,
    });
    console.log(`   User LP Account: ${userLpAccount.toString()}`);

    // ==========================================
    // STEP 7: Call Initialize via CPI
    // ==========================================
    console.log("\n📞 Calling initialize_saros_pool via CPI...\n");

    try {
      const tx = await program.methods
        .initializeSarosPool(
          TRADE_FEE_NUMERATOR,
          TRADE_FEE_DENOMINATOR,
          OWNER_TRADE_FEE_NUMERATOR,
          OWNER_TRADE_FEE_DENOMINATOR,
          OWNER_WITHDRAW_FEE_NUMERATOR,
          OWNER_WITHDRAW_FEE_DENOMINATOR,
          HOST_FEE_NUMERATOR,
          HOST_FEE_DENOMINATOR,
          CURVE_TYPE,
          Array.from(CURVE_PARAMETERS)
        )
        .accounts({
          payer: payer.publicKey,
          poolAccount: poolAccount.publicKey,
          poolAuthority: poolAuthority,
          poolLpMint: poolLpMint.publicKey,
          tokenAInfo: tokenAVault, // Token A vault (TokenAccount)
          tokenBInfo: tokenBVault, // Token B vault (TokenAccount)
          feeAccount: feeAccount,
          userLpAccount: userLpAccount
        })
        .signers([poolAccount, poolLpMint])
        .rpc();

      console.log("✅ Transaction successful!");
      console.log(`   Signature: ${tx}`);
      console.log("\n🎉 Pool initialized successfully!\n");

      // Verify
      console.log("📋 Verifying pool...");
      const poolInfo = await provider.connection.getAccountInfo(poolAccount.publicKey);
      assert.ok(poolInfo, "Pool created");
      
      const lpMintInfo = await getMint(provider.connection, poolLpMint.publicKey);
      console.log(`   LP Supply: ${lpMintInfo.supply.toString()}`);

    } catch (error) {
      console.error("❌ Error:", error);      
      throw error;
    }
  });
});