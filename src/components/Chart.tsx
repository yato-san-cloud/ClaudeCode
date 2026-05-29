import { useEffect, useRef } from 'react';
import {
  CandlestickSeriesOptions,
  ColorType,
  createChart,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../types';
import { getProvider } from '../market';
import { useQuotesStore } from '../store/useQuotesStore';

interface Props {
  symbol: string;
}

const UP = '#26a69a';
const DOWN = '#ef5350';

/**
 * Candlestick + volume chart that loads synthesized/real history for the
 * symbol and then updates the final bar live as new quotes arrive.
 */
export function Chart({ symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastBarRef = useRef<Candle | null>(null);
  const barStartRef = useRef<number>(0);

  // Create the chart once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#c9d1d9',
      },
      grid: {
        vertLines: { color: '#1b2230' },
        horzLines: { color: '#1b2230' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    } as Partial<CandlestickSeriesOptions>);

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Load history whenever the symbol changes.
  useEffect(() => {
    let cancelled = false;
    void getProvider()
      .getCandles(symbol, 120)
      .then((candles) => {
        if (cancelled || !candleSeriesRef.current || !volumeSeriesRef.current) return;
        candleSeriesRef.current.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
        volumeSeriesRef.current.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
          })),
        );
        chartRef.current?.timeScale().fitContent();
        const last = candles[candles.length - 1] ?? null;
        lastBarRef.current = last;
        barStartRef.current = last ? last.time : 0;
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // Live-update the trailing bar from the quote stream.
  useEffect(() => {
    const unsub = useQuotesStore.subscribe((state) => {
      const q = state.quotes[symbol];
      const candleSeries = candleSeriesRef.current;
      const volumeSeries = volumeSeriesRef.current;
      const last = lastBarRef.current;
      if (!q || !candleSeries || !volumeSeries || !last) return;

      const bucket = Math.floor(q.time / 1000 / 60) * 60; // 1-minute buckets
      if (bucket > barStartRef.current) {
        // Start a new bar.
        const bar: Candle = {
          time: bucket,
          open: last.close,
          high: Math.max(last.close, q.price),
          low: Math.min(last.close, q.price),
          close: q.price,
          volume: 0,
        };
        lastBarRef.current = bar;
        barStartRef.current = bucket;
        candleSeries.update({
          time: bar.time as Time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });
      } else {
        // Extend the current bar.
        last.high = Math.max(last.high, q.price);
        last.low = Math.min(last.low, q.price);
        last.close = q.price;
        candleSeries.update({
          time: last.time as Time,
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
        });
      }
    });
    return unsub;
  }, [symbol]);

  return <div className="chart" ref={containerRef} />;
}
