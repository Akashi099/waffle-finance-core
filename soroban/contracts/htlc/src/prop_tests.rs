#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{Address, Bytes, BytesN, Env};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use std::vec::Vec;

// Simple action set for sequences
#[derive(Clone, Debug)]
enum Action {
    Create { amount: i128, safety: i128, timelock: u64 },
    Claim { order_idx: usize, use_correct_preimage: bool },
    Refund { order_idx: usize },
    Advance { seconds: u64 },
}

// Strategy: generate a small sequence of actions
fn actions_strategy() -> impl Strategy<Value = Vec<Action>> {
    let create = (1i128..1_000_000i128, 0i128..100_000i128, 300u64..86_400u64).prop_map(
        |(a, s, t)| Action::Create { amount: a, safety: s, timelock: t },
    );
    let claim = (0usize..10usize, prop::bool::ANY).prop_map(|(i, b)| Action::Claim { order_idx: i, use_correct_preimage: b });
    let refund = (0usize..10usize).prop_map(|i| Action::Refund { order_idx: i });
    let advance = (1u64..1000u64).prop_map(|s| Action::Advance { seconds: s });

    prop::collection::vec(prop_oneof![create, claim, refund, advance], 1..12)
}

proptest! {
    #[test]
    fn conservation_of_tokens(seq in actions_strategy()) {
        let env = Env::default();
        env.mock_all_auths();

        // Deploy token and HTLC
        let asset_admin = Address::generate(&env);
        let (asset, sac, token_client) = {
            let contract = env.register_stellar_asset_contract_v2(asset_admin.clone());
            let addr = contract.address();
            (
                addr.clone(),
                StellarAssetClient::new(&env, &addr),
                TokenClient::new(&env, &addr),
            )
        };

        let admin = Address::generate(&env);
        let htlc_contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
        let htlc_client = HtlcContractClient::new(&env, &htlc_contract_id);

        // Keep track of accounts and initial balances
        let mut accounts: Vec<Address> = Vec::new();
        let mut preimages: Vec<Bytes> = Vec::new();
        let mut order_ids: Vec<Option<u64>> = Vec::new();

        // Seed some accounts
        for _ in 0..6 {
            let a = Address::generate(&env);
            sac.mint(&a, &1_000_0000000);
            accounts.push(a);
        }

        let initial_total: i128 = accounts.iter().map(|a| token_client.balance(a)).sum();

        for act in seq {
            match act {
                Action::Create { amount, safety, timelock } => {
                    // pick sender and beneficiary
                    let sender = accounts[(env.ledger().sequence() as usize) % accounts.len()].clone();
                    let beneficiary = accounts[((env.ledger().sequence() as usize) + 1) % accounts.len()].clone();
                    let pre = Bytes::from_array(&env, &[42u8; 32]);
                    let hashlock = BytesN::<32>::from(env.crypto().sha256(&pre));
                    // attempt create_order, ignore panics
                    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| htlc_client.create_order(&sender, &beneficiary, &sender, &asset, &amount, &safety, &hashlock, &timelock)));
                    match res {
                        Ok(id) => {
                            order_ids.push(Some(id));
                            preimages.push(pre.clone());
                        }
                        Err(_) => {
                            order_ids.push(None);
                            preimages.push(Bytes::new(&env));
                        }
                    }
                }
                Action::Claim { order_idx, use_correct_preimage } => {
                    if let Some(id_opt) = order_ids.get(order_idx) {
                        if let Some(id) = id_opt {
                            let caller = accounts[(env.ledger().sequence() as usize + 2) % accounts.len()].clone();
                            let pre = if use_correct_preimage { preimages[order_idx].clone() } else { Bytes::from_array(&env, &[7u8; 32]) };
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| htlc_client.claim_order(id, &pre, &caller)));
                        }
                    }
                }
                Action::Refund { order_idx } => {
                    if let Some(id_opt) = order_ids.get(order_idx) {
                        if let Some(id) = id_opt {
                            let caller = accounts[(env.ledger().sequence() as usize + 3) % accounts.len()].clone();
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| htlc_client.refund_order(id, &caller)));
                        }
                    }
                }
                Action::Advance { seconds } => {
                    let current = env.ledger().get();
                    env.ledger().set(LedgerInfo { timestamp: current.timestamp + seconds, protocol_version: current.protocol_version, sequence_number: current.sequence_number + 1, network_id: current.network_id, base_reserve: current.base_reserve, min_temp_entry_ttl: current.min_temp_entry_ttl, min_persistent_entry_ttl: current.min_persistent_entry_ttl, max_entry_ttl: current.max_entry_ttl });
                }
            }
        }

        // After sequence, compute total again
        let final_total: i128 = accounts.iter().map(|a| token_client.balance(a)).sum::<i128>() + token_client.balance(&htlc_client.address);

        // Assert conservation: final total equals initial (ignoring tiny differences from safety deposits paid to callers within the account set)
        prop_assert_eq!(final_total, initial_total);
    }
}
