import * as dotenv from "dotenv";
import { getDealsByEbitda } from "./vault";
dotenv.config();

async function runMnaAgentDemo(query: string, ebitdaArg: number, hasPaid: boolean = false) {
  console.log(`\n--- New Request: "${query}" ---`);

  if (!hasPaid) {
    return {
      status: 402,
      message: "Access requires 1 SOL fee.",
      payment_to: process.env.AGENT_WALLET,
      amount: 1,
      program_id: process.env.MNA_PROGRAM_ID,
    };
  }

  const results = getDealsByEbitda(ebitdaArg);

  return {
    status: 200,
    response: "I found these matching deals in the SMBmarket vault:",
    deals: results,
  };
}

(async () => {
  const unpaidResult = await runMnaAgentDemo("Show me profitable deals", 200000);
  console.log(unpaidResult);

  const paidResult = await runMnaAgentDemo("Show me profitable deals", 200000, true);
  console.log(paidResult);
})();
