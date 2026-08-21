/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.Beacon;
import java.io.Serializable;
import java.util.Date;

public class MeetLog
implements Serializable,
Comparable<MeetLog> {
    private static final long serialVersionUID = 4558153818279953014L;
    public final Date t;
    public final String user;
    public final Beacon beacon;

    public MeetLog(Date t2, String user, Beacon beacon) {
        this.t = t2;
        this.user = user;
        this.beacon = beacon;
    }

    @Override
    public int compareTo(MeetLog arg0) {
        return this.t.compareTo(arg0.t);
    }
}

