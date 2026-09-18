/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import com.hitachi.warehouse.model.picking.Session;
import com.hitachi.warehouse.model.picking.Shelf;
import com.hitachi.warehouse.model.picking.shelffactory.AbstractShelfFactory;
import common.util.DateUtil;
import java.io.Serializable;
import java.util.Date;
import java.util.Map;

public class PickingRecord
implements Serializable,
Comparable<PickingRecord> {
    private static final long serialVersionUID = -9045890365000492936L;
    private String pickingID;
    private int bucketNo;
    private Date tStart;
    private Date tEnd;
    private Shelf shelf;
    private Session session;
    private String productCode;
    private int numOrderedBoxes;
    private int numOrderedProducts;
    private int numCollectedBoxes;
    private int numCollectedProducts;
    private String clientID;
    private int pickingPriority;

    public PickingRecord(Session session, Map<String, String> vals, AbstractShelfFactory shelfFactory) {
        this.session = session;
        this.pickingID = vals.get("取込No");
        this.setBucketNo(Integer.parseInt(vals.get("バケットNo")));
        this.settStart(DateUtil.str2DateTime(vals.get("作業開始日時")));
        this.settEnd(DateUtil.str2DateTime(vals.get("作業終了日時")));
        try {
            this.setShelf(shelfFactory.shelfFromStrs(vals.get("列"), vals.get("棚連No"), vals.get("棚番"), vals.get("棚段No")));
        }
        catch (Exception e) {
            System.err.println(String.valueOf(vals.get("列")) + " " + vals.get("棚連No") + " " + vals.get("棚番") + " " + vals.get("棚段No"));
            e.printStackTrace();
        }
        this.setProductCode(vals.get("商品コード４5桁"));
        this.setNumOrderedBoxes(Integer.parseInt(vals.get("指示函数")));
        this.setNumOrderedProducts(Integer.parseInt(vals.get("指示バラ数")));
        this.setNumCollectedBoxes(Integer.parseInt(vals.get("実績函数")));
        this.setNumCollectedProducts(Integer.parseInt(vals.get("実績バラ数")));
        this.setClientID(vals.get("得意先"));
        this.setPickingPriority(Integer.parseInt(vals.get("両側ピック順位")));
    }

    @Override
    public int compareTo(PickingRecord arg0) {
        return this.tStart().compareTo(arg0.tStart());
    }

    public String toString() {
        return String.valueOf(DateUtil.dateTime2Str(this.tStart())) + "\t" + DateUtil.dateTime2Str(this.tEnd()) + "\t" + DateUtil.durationSeconds(this.tStart(), this.tEnd()) + "\t" + this.shelf() + "\t" + this.productCode() + "\t" + (this.numCollectedBoxes() + this.numCollectedProducts());
    }

    public Session session() {
        return this.session;
    }

    public void setSession(Session session) {
        this.session = session;
    }

    public String fullBucketID() {
        return String.valueOf(this.session.sessionID) + "-" + this.bucketNo();
    }

    public String pickingID() {
        return this.pickingID;
    }

    public int bucketNo() {
        return this.bucketNo;
    }

    public void setBucketNo(int bucketNo) {
        this.bucketNo = bucketNo;
    }

    public Date tStart() {
        return this.tStart;
    }

    public void settStart(Date tStart) {
        this.tStart = tStart;
    }

    public Date tEnd() {
        return this.tEnd;
    }

    public void settEnd(Date tEnd) {
        this.tEnd = tEnd;
    }

    public Shelf shelf() {
        return this.shelf;
    }

    public void setShelf(Shelf shelf) {
        this.shelf = shelf;
    }

    public String productCode() {
        return this.productCode;
    }

    public void setProductCode(String productCode) {
        this.productCode = productCode;
    }

    public int numOrderedBoxes() {
        return this.numOrderedBoxes;
    }

    public void setNumOrderedBoxes(int numOrderedBoxes) {
        this.numOrderedBoxes = numOrderedBoxes;
    }

    public int numOrderedProducts() {
        return this.numOrderedProducts;
    }

    public void setNumOrderedProducts(int numOrderedProducts) {
        this.numOrderedProducts = numOrderedProducts;
    }

    public boolean hasUnPickedItems() {
        return this.numCollectedBoxes() < this.numOrderedBoxes() || this.numCollectedProducts() < this.numOrderedProducts();
    }

    public int numCollectedBoxes() {
        return this.numCollectedBoxes;
    }

    public void setNumCollectedBoxes(int numCollectedBoxes) {
        this.numCollectedBoxes = numCollectedBoxes;
    }

    public int numCollectedProducts() {
        return this.numCollectedProducts;
    }

    public void setNumCollectedProducts(int numCollectedProducts) {
        this.numCollectedProducts = numCollectedProducts;
    }

    public String clientID() {
        return this.clientID;
    }

    public void setClientID(String clientID) {
        this.clientID = clientID;
    }

    public int pickingPriority() {
        return this.pickingPriority;
    }

    private void setPickingPriority(int pickingPriority) {
        this.pickingPriority = pickingPriority;
    }
}

