use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token},
};
use saros; // Import the Saros wrapper

declare_id!("B97pzUX6EzCNqrGXRNUvHwgVnW5HTgzhGDFMdi1qjkQZ");

#[program]
pub mod migrate_saros {
    use super::*;

    /// Initialize a new Saros swap pool
    ///
    /// This function creates a new liquidity pool on Saros AMM via CPI
    /// Following the account derivation pattern from Saros SDK
    pub fn initialize_saros_pool(
        ctx: Context<InitializeSarosPool>,
        trade_fee_numerator: u64,
        trade_fee_denominator: u64,
        owner_trade_fee_numerator: u64,
        owner_trade_fee_denominator: u64,
        owner_withdraw_fee_numerator: u64,
        owner_withdraw_fee_denominator: u64,
        host_fee_numerator: u64,
        host_fee_denominator: u64,
        curve_type: u8,
        swap_calculator: [u8; 32],
    ) -> Result<()> {
        // Build the Fees structure (using generated types from saros)
        let fees = saros::types::Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        // Build the SwapCurve enum (using generated types from saros)
        let swap_curve = match curve_type {
            0 => saros::types::SwapCurve::ConstantProduct,
            1 => saros::types::SwapCurve::ConstantPrice,
            2 => saros::types::SwapCurve::Stable,
            3 => saros::types::SwapCurve::Offset,
            _ => return Err(ErrorCode::InvalidCurveType.into()),
        };
        // Make CPI call to Saros initialize instruction
        saros::cpi::initialize(
            CpiContext::new(
                ctx.accounts.saros_program.to_account_info(),
                saros::cpi::accounts::Initialize {
                    swap_info: ctx.accounts.pool_account.to_account_info(),
                    authority_info: ctx.accounts.pool_authority.to_account_info(),
                    token_a_info: ctx.accounts.token_a_info.to_account_info(),
                    token_b_info: ctx.accounts.token_b_info.to_account_info(),
                    pool_mint_info: ctx.accounts.pool_lp_mint.to_account_info(),
                    fee_account_info: ctx.accounts.fee_account.to_account_info(),
                    destination_info: ctx.accounts.user_lp_account.to_account_info(),
                    token_program_info: ctx.accounts.token_program.to_account_info(),
                },
            ),
            fees,
            swap_curve,
            swap_calculator,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeSarosPool<'info> {
    /// Payer for account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The pool account (must be a signer)
    /// This is created from: Keypair::from_seed(PDA_seed)
    /// where PDA_seed = find_program_address([random_keypair], saros_program)
    #[account(mut)]
    pub pool_account: Signer<'info>,

    /// Pool authority PDA
    /// Derivation: find_program_address([pool_account.key], saros_program)
    /// CHECK: Validated by Saros program
    pub pool_authority: UncheckedAccount<'info>,

    /// LP token mint (created from authority bytes as seed)
    /// Derivation: Keypair::from_seed(pool_authority.to_bytes())
    #[account(mut)]
    pub pool_lp_mint: Signer<'info>,

    /// Token A mint address
    pub token_a_info: Account<'info, Mint>,

    /// Token B mint address
    pub token_b_info: Account<'info, Mint>,

    /// Fee collection account (ATA of fee owner for LP mint)
    /// Derivation: get_associated_token_address(fee_owner, pool_lp_mint)
    /// CHECK: Validated by Saros program
    #[account(mut)]
    pub fee_account: UncheckedAccount<'info>,

    /// User LP token account (ATA of payer for LP mint)
    /// Derivation: get_associated_token_address(payer, pool_lp_mint)
    /// CHECK: Validated by Saros program
    #[account(mut)]
    pub user_lp_account: UncheckedAccount<'info>,

    /// Saros swap program
    /// CHECK: Verified by address constraint
    #[account(address = saros::ID)]
    pub saros_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid curve type. Must be 0-3 (ConstantProduct, ConstantPrice, Stable, Offset)")]
    InvalidCurveType,
}
