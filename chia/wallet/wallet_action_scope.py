from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, AsyncIterator, List, Optional, cast, final

from chia.types.blockchain_format.program import Program
from chia.types.blockchain_format.sized_bytes import bytes32
from chia.types.spend_bundle import SpendBundle
from chia.util.action_scope import ActionScope
from chia.util.streamable import Streamable, streamable
from chia.wallet.signer_protocol import SigningResponse
from chia.wallet.transaction_record import TransactionRecord
from chia.wallet.util.tx_config import TXConfig

if TYPE_CHECKING:
    # Avoid a circular import here
    from chia.wallet.wallet_state_manager import WalletStateManager


@streamable
@dataclass(frozen=True)
class _StreamableWalletSideEffects(Streamable):
    transactions: List[TransactionRecord]
    signing_responses: List[SigningResponse]
    extra_spends: List[SpendBundle]
    solutions: List[Program]
    coin_ids: List[bytes32]


@dataclass
class WalletSideEffects:
    transactions: List[TransactionRecord] = field(default_factory=list)
    signing_responses: List[SigningResponse] = field(default_factory=list)
    extra_spends: List[SpendBundle] = field(default_factory=list)
    solutions: List[Program] = field(default_factory=list)
    coin_ids: List[bytes32] = field(default_factory=list)

    def __bytes__(self) -> bytes:
        return bytes(_StreamableWalletSideEffects(**self.__dict__))

    @classmethod
    def from_bytes(cls, blob: bytes) -> WalletSideEffects:
        return cls(**_StreamableWalletSideEffects.from_bytes(blob).__dict__)

    def merge(self, other: WalletSideEffects) -> None:
        self.transactions.extend(other.transactions)
        self.signing_responses.extend(other.signing_responses)
        self.extra_spends.extend(other.extra_spends)
        self.solutions.extend(other.solutions)
        self.coin_ids.extend(other.coin_ids)


@final
@dataclass(frozen=True)
class WalletActionConfig:
    push: bool
    merge_spends: bool
    sign: Optional[bool]
    additional_signing_responses: List[SigningResponse]
    extra_spends: List[SpendBundle]
    tx_config: TXConfig


WalletActionScope = ActionScope[WalletSideEffects, WalletActionConfig]


@contextlib.asynccontextmanager
async def new_wallet_action_scope(
    wallet_state_manager: WalletStateManager,
    tx_config: TXConfig,
    push: bool = False,
    merge_spends: bool = True,
    sign: Optional[bool] = None,
    additional_signing_responses: List[SigningResponse] = [],
    extra_spends: List[SpendBundle] = [],
) -> AsyncIterator[WalletActionScope]:
    async with ActionScope.new_scope(
        WalletSideEffects,
        WalletActionConfig(push, merge_spends, sign, additional_signing_responses, extra_spends, tx_config),
    ) as self:
        self = cast(WalletActionScope, self)
        async with self.use() as interface:
            interface.side_effects.signing_responses = additional_signing_responses.copy()
            interface.side_effects.extra_spends = extra_spends.copy()

        yield self

    self.side_effects.transactions = await wallet_state_manager.add_pending_transactions(
        self.side_effects.transactions,
        push=push,
        merge_spends=merge_spends,
        sign=sign,
        additional_signing_responses=self.side_effects.signing_responses,
        extra_spends=self.side_effects.extra_spends,
    )
