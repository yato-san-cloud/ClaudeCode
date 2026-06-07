/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.User;
import common.util.CSVReader;
import java.io.File;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;

public class Users {
    HashMap<String, User> userForBMSID = new HashMap();
    HashMap<String, User> userForWMSID = new HashMap();

    public Users(File f2) {
        for (List<String> strs : CSVReader.readAsVList(f2)) {
            if (strs.size() < 2) continue;
            String wmsID = strs.get(0).trim().substring(1);
            String bmsID = strs.get(1).toLowerCase();
            User user = new User(bmsID, wmsID);
            this.userForBMSID.put(user.bmsUserID, user);
            this.userForWMSID.put(user.wmsUserID, user);
        }
    }

    public User userForBMSID(String bmsID) {
        return this.userForBMSID.get(bmsID.toLowerCase());
    }

    public User userForWMSID(String wmsID) {
        return this.userForWMSID.get(wmsID);
    }

    public Collection<User> users() {
        return this.userForBMSID.values();
    }
}

