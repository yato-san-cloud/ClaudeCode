/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.util;

import com.hitachi.warehouse.model.map.Waypoint;
import java.util.ArrayList;
import java.util.NoSuchElementException;

public final class WaypointFibonacciHeap {
    private Entry mMin = null;
    private int mSize = 0;

    public Entry enqueue(Waypoint value) {
        Entry result = new Entry(value);
        this.mMin = WaypointFibonacciHeap.mergeLists(this.mMin, result);
        ++this.mSize;
        return result;
    }

    public Entry min() {
        if (this.isEmpty()) {
            throw new NoSuchElementException("Heap is empty.");
        }
        return this.mMin;
    }

    public boolean isEmpty() {
        return this.mMin == null;
    }

    public int size() {
        return this.mSize;
    }

    public Entry dequeueMin() {
        if (this.isEmpty()) {
            throw new NoSuchElementException("Heap is empty.");
        }
        --this.mSize;
        Entry minElem = this.mMin;
        if (this.mMin.mNext == this.mMin) {
            this.mMin = null;
        } else {
            this.mMin.mPrev.mNext = this.mMin.mNext;
            this.mMin.mNext.mPrev = this.mMin.mPrev;
            this.mMin = this.mMin.mNext;
        }
        if (minElem.mChild != null) {
            Entry curr = minElem.mChild;
            do {
                curr.mParent = null;
            } while ((curr = curr.mNext) != minElem.mChild);
        }
        this.mMin = WaypointFibonacciHeap.mergeLists(this.mMin, minElem.mChild);
        if (this.mMin == null) {
            return minElem;
        }
        ArrayList<Entry> treeTable = new ArrayList<Entry>();
        ArrayList<Entry> toVisit = new ArrayList<Entry>();
        Entry curr2 = this.mMin;
        while (toVisit.isEmpty() || toVisit.get(0) != curr2) {
            toVisit.add(curr2);
            curr2 = curr2.mNext;
        }
        for (Entry curr2 : toVisit) {
            while (true) {
                if (curr2.mDegree >= treeTable.size()) {
                    treeTable.add(null);
                    continue;
                }
                if (treeTable.get(curr2.mDegree) == null) break;
                Entry other = (Entry)treeTable.get(curr2.mDegree);
                treeTable.set(curr2.mDegree, null);
                Entry min = ((Entry)other).mElem._USERDATA_DOUBLE_0 < ((Entry)curr2).mElem._USERDATA_DOUBLE_0 ? other : curr2;
                Entry max = ((Entry)other).mElem._USERDATA_DOUBLE_0 < ((Entry)curr2).mElem._USERDATA_DOUBLE_0 ? curr2 : other;
                max.mNext.mPrev = max.mPrev;
                max.mPrev.mNext = max.mNext;
                Entry entry = max;
                max.mPrev = entry;
                max.mNext = entry;
                min.mChild = WaypointFibonacciHeap.mergeLists(min.mChild, max);
                max.mParent = min;
                max.mIsMarked = false;
                Entry entry2 = min;
                entry2.mDegree = entry2.mDegree + 1;
                curr2 = min;
            }
            treeTable.set(curr2.mDegree, curr2);
            if (!(((Entry)curr2).mElem._USERDATA_DOUBLE_0 <= ((Entry)this.mMin).mElem._USERDATA_DOUBLE_0)) continue;
            this.mMin = curr2;
        }
        return minElem;
    }

    public void decreaseKey(Entry entry, double newPriority) {
        this.checkPriority(newPriority);
        if (newPriority > ((Entry)entry).mElem._USERDATA_DOUBLE_0) {
            throw new IllegalArgumentException("New priority exceeds old.");
        }
        this.decreaseKeyUnchecked(entry, newPriority);
    }

    public void delete(Entry entry) {
        this.decreaseKeyUnchecked(entry, Double.NEGATIVE_INFINITY);
        this.dequeueMin();
    }

    private void checkPriority(double priority) {
        if (Double.isNaN(priority)) {
            throw new IllegalArgumentException(String.valueOf(priority) + " is invalid.");
        }
    }

    private static Entry mergeLists(Entry one, Entry two) {
        if (one == null && two == null) {
            return null;
        }
        if (one != null && two == null) {
            return one;
        }
        if (one == null && two != null) {
            return two;
        }
        Entry oneNext = one.mNext;
        one.mNext = two.mNext;
        one.mNext.mPrev = one;
        two.mNext = oneNext;
        two.mNext.mPrev = two;
        return ((Entry)one).mElem._USERDATA_DOUBLE_0 < ((Entry)two).mElem._USERDATA_DOUBLE_0 ? one : two;
    }

    private void decreaseKeyUnchecked(Entry entry, double priority) {
        ((Entry)entry).mElem._USERDATA_DOUBLE_0 = priority;
        if (entry.mParent != null && ((Entry)entry).mElem._USERDATA_DOUBLE_0 <= ((Entry)((Entry)entry).mParent).mElem._USERDATA_DOUBLE_0) {
            this.cutNode(entry);
        }
        if (((Entry)entry).mElem._USERDATA_DOUBLE_0 <= ((Entry)this.mMin).mElem._USERDATA_DOUBLE_0) {
            this.mMin = entry;
        }
    }

    private void cutNode(Entry entry) {
        entry.mIsMarked = false;
        if (entry.mParent == null) {
            return;
        }
        if (entry.mNext != entry) {
            entry.mNext.mPrev = entry.mPrev;
            entry.mPrev.mNext = entry.mNext;
        }
        if (entry.mParent.mChild == entry) {
            if (entry.mNext != entry) {
                entry.mParent.mChild = entry.mNext;
            } else {
                entry.mParent.mChild = null;
            }
        }
        Entry entry2 = entry.mParent;
        entry2.mDegree = entry2.mDegree - 1;
        Entry entry3 = entry;
        entry.mNext = entry3;
        entry.mPrev = entry3;
        this.mMin = WaypointFibonacciHeap.mergeLists(this.mMin, entry);
        if (entry.mParent.mIsMarked) {
            this.cutNode(entry.mParent);
        } else {
            entry.mParent.mIsMarked = true;
        }
        entry.mParent = null;
    }

    public static final class Entry {
        private int mDegree = 0;
        private boolean mIsMarked = false;
        private Entry mNext = this.mPrev = this;
        private Entry mPrev;
        private Entry mParent;
        private Entry mChild;
        private Waypoint mElem;

        public Waypoint getValue() {
            return this.mElem;
        }

        public void setValue(Waypoint value) {
            this.mElem = value;
        }

        public double getPriority() {
            return this.mElem._USERDATA_DOUBLE_0;
        }

        private Entry(Waypoint elem) {
            this.mElem = elem;
        }
    }
}

