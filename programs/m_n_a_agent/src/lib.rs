use anchor_lang::prelude::*;

declare_id!("Au6NovuciU92yG7tJf7ZwkXc3zazAGY7GepbuJ3vtPMt");

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
