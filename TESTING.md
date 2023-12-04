# Testing plan

## Glossary

### List

What i refer to list(for simplicity) in this document, is in fact dictionary with sequentially ordered indexes.
All of such structures (`signers`, `proposers`, `order`) should be checked for indexes order.
If list is not compliant with expected format, `error::invalid_dictionary_sequence` should be thrown.

### Signers

Signers is a list of wallet addresses of `multiowner` wallet contract owners.  
Each signer can create new order and vote for approval

### Proposers

Proposers is the list of wallet addresses allowed to only create new orders, but **can't vote for approval**.

## Multiowner testing

## New order

- Only proposers and signers should be able to create new order.
- Order expiration time should exceed current time.
- Incoming value should be >= expected processing cost.
- Order can't be empty.
- Only successful `new_order` execution should produce deploy message for `order` contract.
- Deploy message should result in successful `order` deployment with matching *threshold, signers, number of signers, expiration date and order body*.
- Only successful `new_order` execution should result in `order_seqno` increase.

### Execute order

- Only `order` contract with according `order_seqno` and `signers` hash (specified in message) should be able to trigger that operation.
- `signers` cell hash in incoming message should match current state `signers` hash. Should guarantee that change of signers results in orders invalidation.
- Should trigger actions processing sequentially according to order list.
- Minimal processing cost calculated at `New order` stage should be >= actual costs of executing order including storage.

### Execute internal order

- Should only be able to trigger from self address.  
- Main intention is to allow chained order execution.  
- Should trigger actions processing according to passed order list.

### Order processing

Execute order message contains list with actions of two(currenty) types:

- Outgoing message.
- Update multisig parameters.

#### Outgoing message

Specifies message mode and message cell.  
Results in according message being sent.

#### Update multiowner marameters

Specifies multiowner state parameters such as:

- Order threshold
- Signers list
- Proposers list
- Modules prefix dictionary
- Guard contract cell

Should result in according contract state changes.

### Experimental

All features below should only be accessible when contract is deployed with `EXPERIMENTAL_FEATURES` flag set.

#### Module functionality execution

- Module should be present in modules prefix dictionary by sender address used as a key.  
- Should result in module order being processed

#### Guard functionality execution

Guard is separate contract with it's own state (data/code) main purpose of which is to check execution context prior to action phase and react accordingly.
For instance, prevent forbidden actions from execution.(?)

## Guarantee cases

- Nobody except `proposers` and `owners` can initiate creation of new order, nobody except `owners` can approve new order.
- Chenge of the `owners` set invalidates all orders with old set.
- `Owner` compromise, in particularly compromise of less than N `owners`, does not hinder to execute orders or to propose new ones (including orders which will remove compromised `owners` from the owners list)
- `Proposer` compromise does not hinder to execute orders or to propose new ones (including orders which will remove compromised `proposer` from the proposers list)
- Logic of multiapproval wallet can not changed

## Order contract testing

### Initialization

- Order contract should only be able to initialize once.
- Order contract should only accept initialization messages from `multiowner` address.
- Execution threshold should be set according to init message.
- Signers list should be set according to init message.
- Expiration date should exceed current timestamp(Should not be expired at the time of receiving a message).
- Expiration date should be set according to init message.
- Execution and approval state fields such as `approvals`(bit mask), `approvals_num`, `executed` should be zeroed out.
- If signer initiated order contract deployment, it's approval should be accounted for. In case `threshold = 1` order should get executed.

### Order approval

Approval state is described with following fields:  

- `approvals` is a bit mask where each bit describes signed position(bit position) and bit value describes presence of approval(true -> approved).
- `approvals_num` is an approval counter that is compared against `threshold` during order execution check.

In case approval is granted, bit is set in `approvals` mask in accordance with signer position in `signers` list.

For approval to be granted:  

- Sender address should be present in `signers` list.
- Signer index specified in message, should match sender address position at `signers` list.
- Order should not be expired (`expiration_date < now()`).
- Order can only be executed once `executed` field should be `false`.
- Signer at specified index in `approvals` mask has not granted approval yet.(`error::already_approved`)

In case order is expired:

- Message carrying remaining value and indicating expiry is sent back to approval sender address.
- Message carrying all of the order contract remaining balance is sent back to the `multiowner` contract.

In case order is already executed, message carrying remaining value is sent back to approval sender address.

### Order execution

On every initialization or order approval action, contract check if it's possible to execute order (order count has reached threshold).
If so:

- `op::execute` message, carrying all remaining balance is sent to `multiowner` contract.
- `executed` flag is set to true and repeated execution should not be possible afterwards.
