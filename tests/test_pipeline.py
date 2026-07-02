import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from jancode_dimensions.cache import Cache  # noqa: E402
from jancode_dimensions.models import Dimensions, ProductInfo  # noqa: E402
from jancode_dimensions.pipeline import LookupPipeline, normalize_jan  # noqa: E402
from jancode_dimensions.providers.base import DimensionProvider  # noqa: E402


class FakeProvider(DimensionProvider):
    def __init__(self, name, table):
        self.name = name
        self.table = table
        self.calls = 0

    def lookup(self, jan):
        self.calls += 1
        return self.table.get(jan)


def test_normalize_jan():
    assert normalize_jan("4901234567894.0") == "4901234567894"
    assert normalize_jan(" 4901234567894 ") == "4901234567894"
    assert normalize_jan("4-901234-567894") == "4901234567894"
    assert normalize_jan(4901234567894) == "4901234567894"


def test_first_provider_with_dims_wins():
    p1 = FakeProvider("p1", {"111": ProductInfo("111", "p1", dimensions=Dimensions(1, 2, 3))})
    p2 = FakeProvider("p2", {"111": ProductInfo("111", "p2", dimensions=Dimensions(9, 9, 9))})
    pipe = LookupPipeline([p1, p2])
    res = pipe.lookup("111")
    assert res.found and res.source == "p1"
    assert p2.calls == 0  # 早期確定で2番目は呼ばれない


def test_fallback_to_second_provider():
    # p1 は商品を見つけるがサイズ不明 → p2 にフォールバック
    p1 = FakeProvider("p1", {"111": ProductInfo("111", "p1", title="商品", dimensions=None)})
    p2 = FakeProvider("p2", {"111": ProductInfo("111", "p2", dimensions=Dimensions(1, 2, 3))})
    pipe = LookupPipeline([p1, p2])
    res = pipe.lookup("111")
    assert res.found and res.source == "p2"
    assert p1.calls == 1 and p2.calls == 1


def test_not_found():
    p1 = FakeProvider("p1", {})
    pipe = LookupPipeline([p1])
    res = pipe.lookup("999")
    assert not res.found
    assert res.dimensions is None


def test_cache_hit_skips_providers():
    cache = Cache(":memory:")
    provider = FakeProvider("p1", {"111": ProductInfo("111", "p1", dimensions=Dimensions(1, 2, 3))})
    pipe = LookupPipeline([provider], cache=cache)

    first = pipe.lookup("111")
    assert first.found and not first.from_cache
    assert provider.calls == 1

    second = pipe.lookup("111")
    assert second.found and second.from_cache
    assert provider.calls == 1  # 2回目はキャッシュから、プロバイダは呼ばれない


def test_cache_normalizes_jan():
    cache = Cache(":memory:")
    provider = FakeProvider("p1", {"4901234567894": ProductInfo("4901234567894", "p1", dimensions=Dimensions(1, 2, 3))})
    pipe = LookupPipeline([provider], cache=cache)

    pipe.lookup("4901234567894")
    # 表記ゆれでもキャッシュに当たる
    res = pipe.lookup("4901234567894.0")
    assert res.from_cache


def test_verified_cache_beats_providers():
    # 人手確認済み(verified)の行は、サイズ無しでもオンライン再検索しない
    cache = Cache(":memory:")
    cache.put(ProductInfo("111", "manual", title="確認済み商品", dimensions=None), verified=True)
    provider = FakeProvider("p1", {"111": ProductInfo("111", "p1", dimensions=Dimensions(9, 9, 9))})
    pipe = LookupPipeline([provider], cache=cache)

    res = pipe.lookup("111")
    assert res.from_cache
    assert not res.found
    assert provider.calls == 0


class RemoteFakeProvider(FakeProvider):
    is_remote = True


def test_remote_calls_are_throttled():
    provider = RemoteFakeProvider("r", {})  # 常に未発見でもスロットリングされる
    pipe = LookupPipeline([provider], sleep_between=0.08)

    t0 = time.monotonic()
    pipe.lookup("111")
    pipe.lookup("222")
    elapsed = time.monotonic() - t0

    assert provider.calls == 2
    assert elapsed >= 0.07  # 2回目の呼び出しまで最低間隔が空く


def test_local_calls_are_not_throttled():
    provider = FakeProvider("p1", {})  # is_remote=False
    pipe = LookupPipeline([provider], sleep_between=0.5)

    t0 = time.monotonic()
    pipe.lookup("111")
    pipe.lookup("222")
    elapsed = time.monotonic() - t0

    assert provider.calls == 2
    assert elapsed < 0.4  # ローカル参照では待たない
