// import * as anchor from "@coral-xyz/anchor";
// import { Program } from "@coral-xyz/anchor";
// import { MNAAgent } from "../target/types/m_n_a_agent";

// describe("m_n_a_agent", () => {
//   // Configure the client to use the local cluster.
//   anchor.setProvider(anchor.AnchorProvider.env());

//   const program = anchor.workspace.mNAAgent as Program<MNAAgent>;

//   it("Is initialized!", async () => {
//     // Add your test here.
//     const tx = await program.methods.initialize().rpc();
//     console.log("Your transaction signature", tx);
//   });
// });

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MNAAgent } from "../target/types/m_n_a_agent";
import idl from "../target/idl/m_n_a_agent.json"; // 1. Direct Import

describe("m_n_a_agent", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // 2. Manually create the program instance using the IDL
  const program = new Program(idl as any, provider) as Program<MNAAgent>;

  it("Is initialized!", async () => {
    // 3. Execute the transaction
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});
