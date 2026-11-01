import Stripe from "stripe";
import dotenv from "dotenv";
import { IS_CLOUD } from "./const.js";

dotenv.config();

const secretKey = process.env.STRIPE_SECRET_KEY;

export const stripe =
  IS_CLOUD && secretKey
    ? new Stripe(secretKey, {
        typescript: true, // Enable TypeScript support
        // Automatically retry requests that fail with a 429 (rate limit) or transient
        // network/5xx error using Stripe's built-in exponential backoff with jitter.
        maxNetworkRetries: 3,
      })
    : null;
