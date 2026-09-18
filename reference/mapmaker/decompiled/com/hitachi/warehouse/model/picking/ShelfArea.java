/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import common.ds.MapUtil;
import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

public class ShelfArea
implements Serializable {
    private static final long serialVersionUID = 8173288172246546038L;
    static Map<String, Integer> specialColumnCodes = new HashMap<String, Integer>();
    static Map<Integer, String> rev_specialColumnCodes = new HashMap<Integer, String>();
    static Map<String, Integer> specialRowCodes = new HashMap<String, Integer>();
    static Map<Integer, String> rev_specialRowCodes = new HashMap<Integer, String>();
    public static final ShelfArea pickingStartEndShelf;
    public final int column;
    public final int row;

    static {
        specialColumnCodes.put("EO", 100);
        specialColumnCodes.put("HO", 101);
        specialColumnCodes.put("HU", 102);
        specialColumnCodes.put("KA", 103);
        specialColumnCodes.put("KN", 104);
        specialColumnCodes.put("KT", 105);
        specialColumnCodes.put("KU", 106);
        specialColumnCodes.put("SE", 107);
        specialColumnCodes.put("SR", 108);
        specialColumnCodes.put("ZZ", 109);
        specialColumnCodes.put("4T", 110);
        specialColumnCodes.put("FA", 111);
        specialColumnCodes.put("SP", 112);
        specialRowCodes.put("SL", 100);
        specialRowCodes.put("KO", 101);
        specialRowCodes.put("RI", 102);
        specialRowCodes.put("TA", 103);
        specialRowCodes.put("TR", 104);
        specialRowCodes.put("UR", 105);
        specialRowCodes.put("SE", 106);
        specialRowCodes.put("EO", 107);
        specialRowCodes.put("HO", 108);
        specialRowCodes.put("TO", 109);
        specialRowCodes.put("FA", 110);
        specialRowCodes.put("ME", 111);
        rev_specialColumnCodes = MapUtil.reveseMap(specialColumnCodes);
        rev_specialRowCodes = MapUtil.reveseMap(specialRowCodes);
        pickingStartEndShelf = new ShelfArea(-1, -1);
    }

    public static ShelfArea shelfFromStr(String underscoreSeparatedString) {
        String[] split = underscoreSeparatedString.split("_");
        if (split[0].equals("EO")) {
            split[0] = "70";
        }
        return new ShelfArea(split[0], split[1]);
    }

    public static int getRowCode(String rowStr) {
        try {
            int row = Integer.parseInt(rowStr);
            return row;
        }
        catch (NumberFormatException numberFormatException) {
            return specialRowCodes.get(rowStr);
        }
    }

    public static int getColCode(String colStr) {
        try {
            return Integer.parseInt(colStr);
        }
        catch (NumberFormatException numberFormatException) {
            return specialColumnCodes.get(colStr);
        }
    }

    public static String getColStr(int colCode) {
        String str = rev_specialColumnCodes.get(colCode);
        if (str == null) {
            str = "" + colCode;
        }
        return str;
    }

    public static String getRowStr(int rowCode) {
        String str = rev_specialRowCodes.get(rowCode);
        if (str == null) {
            str = "" + rowCode;
        }
        return str;
    }

    public ShelfArea(int col, int row) {
        this.column = col;
        this.row = row;
    }

    public ShelfArea(String column, String row) {
        this(specialColumnCodes.containsKey(column) ? specialColumnCodes.get(column) : Integer.parseInt(column), specialRowCodes.containsKey(row) ? specialRowCodes.get(row) : Integer.parseInt(row));
    }

    public boolean equals(Object _other) {
        ShelfArea other = (ShelfArea)_other;
        return this.column == other.column && this.row == other.row;
    }

    public String toString() {
        String rowStr;
        String colStr = rev_specialColumnCodes.get(this.column);
        if (colStr == null) {
            colStr = "" + this.column;
        }
        if ((rowStr = rev_specialRowCodes.get(this.row)) == null) {
            rowStr = "" + this.row;
        }
        return String.valueOf(colStr) + "_" + rowStr;
    }

    public String colStr() {
        String colStr = rev_specialColumnCodes.get(this.column);
        if (colStr == null) {
            colStr = "" + this.column;
        }
        return colStr;
    }

    public String rowStr() {
        String rowStr = rev_specialRowCodes.get(this.row);
        if (rowStr == null) {
            rowStr = "" + this.row;
        }
        return rowStr;
    }

    public int hashCode() {
        return this.column * 100 + this.row;
    }

    public boolean isReplacementShelf() {
        return this.column == 80 || this.column / 10 == 9;
    }
}

