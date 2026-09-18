/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.State;
import java.io.Serializable;
import java.util.Date;

public class PositionRecord
implements Serializable {
    private static final long serialVersionUID = -6786704698486855874L;
    public final Date t;
    public final State state;

    public PositionRecord(Date t2, State state) {
        this.t = t2;
        this.state = state;
    }
}

