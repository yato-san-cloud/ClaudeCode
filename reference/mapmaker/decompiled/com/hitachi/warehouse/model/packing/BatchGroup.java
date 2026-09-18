/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import java.util.HashMap;

public enum BatchGroup {
    k3(3, "社内小売"),
    k4(4, "ＥＯＳ先付"),
    k5(5, "ＳＰＳ・ＳＰＳ同梱"),
    k6(6, "緊急出荷"),
    k9(9, "宣伝物ローテ"),
    k10(10, "出庫依頼"),
    k80(80, "プラザ総量"),
    k81(81, "井田両国堂"),
    k82(82, "商品別仕分店"),
    k99(99, "配荷・回送");

    public final int id;
    public final String friendly;
    private static HashMap<Integer, BatchGroup> batchGroupForID;

    static {
        batchGroupForID = null;
    }

    private BatchGroup(int id, String friendly) {
        this.id = id;
        this.friendly = friendly;
    }

    public String toString() {
        return this.friendly;
    }

    public static BatchGroup batchGroupForRecordValue(String value) {
        int id = Integer.parseInt(value.substring(2, 4));
        return BatchGroup.batchGroupForID(id);
    }

    public static BatchGroup batchGroupForID(int id) {
        if (batchGroupForID == null) {
            batchGroupForID = new HashMap();
            BatchGroup[] batchGroupArray = BatchGroup.values();
            int n = batchGroupArray.length;
            int n2 = 0;
            while (n2 < n) {
                BatchGroup batch = batchGroupArray[n2];
                batchGroupForID.put(batch.id, batch);
                ++n2;
            }
        }
        return batchGroupForID.get(id);
    }
}

