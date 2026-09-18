"""3PL 物量分析エンジン (whsim 統合) — WMS 出力データの物量推移/ABC/ピーク/在庫回転/
予測/ポートフォリオ分析と自動インサイト。元 3PL 分析ツールから移植した純関数群。"""
from whsim.analysis import analyses, data_io, insights

__all__ = ["analyses", "data_io", "insights"]
