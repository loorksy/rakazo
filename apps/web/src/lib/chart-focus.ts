export interface ChartFocus {
  accountId: string;
  instrumentId: string;
  brokerSymbol: string;
  timeframe?: string;
}

export function publishChartFocus(focus: ChartFocus) {
  window.dispatchEvent(new CustomEvent<ChartFocus>("rakazo-chart-focus", { detail: focus }));
}
