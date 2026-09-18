/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import common.util.CSVReader;
import java.io.File;
import java.util.List;

public class User {
    public final String bmsUserID;
    public final String wmsUserID;

    public User(String bmsUserID, String wmsUserID) {
        this.bmsUserID = bmsUserID;
        this.wmsUserID = wmsUserID;
    }

    public static void main(String[] args) {
        for (List<String> strs : CSVReader.readAsVList(new File("BMS_WMS_ids.csv"))) {
            System.out.println(strs);
        }
    }

    public String toString() {
        return String.valueOf(this.bmsUserID) + ":" + this.wmsUserID;
    }
}

