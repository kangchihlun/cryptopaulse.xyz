## Product Overview

**CryptoPulse** — 一個面向加密貨幣交易者的即時永續合約市場監控儀表板，透過 GPU 渲染漸層熱圖直覺呈現 orderbook 買賣壓力分布，搭配多幣種動量比較面板。

## Target Users

* **加密貨幣交易者 / 量化交易員**: 需要即時監控永續合約市場微觀結構的專業或半專業交易者

  * Context: 在交易時段中持續監控，需要快速判讀買賣壓力變化與多幣種動量走勢

## Core Problems

1. 傳統 orderbook 介面難以直覺感知買賣壓力的時間演變，交易者需要花大量時間人工比對

2. 缺乏跨幣種動量的統一比較視圖，難以快速發現相對強弱

## Product Scope

**Core Features** (directly deliver value):

* [ ] Dashboard: GPU 渲染漸層熱圖，X 軸為時間軸、Y 軸為當前價格上下 25 檔的 orderbook depth，強買壓顯示亮綠、強賣壓顯示紅色
* [ ] Momentum Compare: 多幣種動量並排比較面板，展示各加密貨幣的相對強弱

**Supporting Features** (enable or enhance core):

* [ ] Coin Detail: 單一幣種的深度分析頁面，含獨立熱圖與詳細指標

## Out of Scope

* 實際下單交易功能: 本產品定位為監控工具，非交易執行平台

* 帳戶與資金管理: 不涉及用戶資產

* 歷史資料回測: 當前聚焦即時監控
