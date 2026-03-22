use anchor_lang::prelude::*;

declare_id!("8iYYQGPJfMxAqwpdBMnPdF9oks3cBu5R23EovNRwCHG8");

#[program]
pub mod m_n_a_agent {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
