import type { Chart } from "klinecharts";
import "@klinecharts/pro";

/** The pinned ESM lifecycle patch only; upstream declarations remain unchanged. */
declare module "@klinecharts/pro" {
  interface KLineChartPro {
    getChartApi(): Chart;
    destroy(): void;
  }
}
