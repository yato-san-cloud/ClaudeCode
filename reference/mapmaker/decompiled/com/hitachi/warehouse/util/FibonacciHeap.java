/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.util;

import java.util.ArrayList;
import java.util.NoSuchElementException;

public final class FibonacciHeap<T> {
    private Entry<T> mMin = null;
    private int mSize = 0;

    public Entry<T> enqueue(T value, double priority) {
        this.checkPriority(priority);
        Entry result = new Entry(value, priority);
        this.mMin = FibonacciHeap.mergeLists(this.mMin, result);
        ++this.mSize;
        return result;
    }

    public Entry<T> min() {
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

    public static <T> FibonacciHeap<T> merge(FibonacciHeap<T> one, FibonacciHeap<T> two) {
        FibonacciHeap<T> result = new FibonacciHeap<T>();
        result.mMin = FibonacciHeap.mergeLists(one.mMin, two.mMin);
        result.mSize = one.mSize + two.mSize;
        two.mSize = 0;
        one.mSize = 0;
        one.mMin = null;
        two.mMin = null;
        return result;
    }

    public Entry<T> dequeueMin() {
        if (this.isEmpty()) {
            throw new NoSuchElementException("Heap is empty.");
        }
        --this.mSize;
        Entry<T> minElem = this.mMin;
        if (((Entry)this.mMin).mNext == this.mMin) {
            this.mMin = null;
        } else {
            ((Entry)this.mMin).mPrev.mNext = ((Entry)this.mMin).mNext;
            ((Entry)this.mMin).mNext.mPrev = ((Entry)this.mMin).mPrev;
            this.mMin = ((Entry)this.mMin).mNext;
        }
        if (((Entry)minElem).mChild != null) {
            Entry curr = ((Entry)minElem).mChild;
            do {
                curr.mParent = null;
            } while ((curr = curr.mNext) != ((Entry)minElem).mChild);
        }
        this.mMin = FibonacciHeap.mergeLists(this.mMin, ((Entry)minElem).mChild);
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
                Entry min = other.mPriority < curr2.mPriority ? other : curr2;
                Entry max = other.mPriority < curr2.mPriority ? curr2 : other;
                max.mNext.mPrev = max.mPrev;
                max.mPrev.mNext = max.mNext;
                Entry entry = max;
                max.mPrev = entry;
                max.mNext = entry;
                min.mChild = (Entry)FibonacciHeap.mergeLists(min.mChild, max);
                max.mParent = min;
                max.mIsMarked = false;
                Entry entry2 = min;
                entry2.mDegree = entry2.mDegree + 1;
                curr2 = min;
            }
            treeTable.set(curr2.mDegree, curr2);
            if (!(curr2.mPriority <= ((Entry)this.mMin).mPriority)) continue;
            this.mMin = curr2;
        }
        return minElem;
    }

    public void decreaseKey(Entry<T> entry, double newPriority) {
        this.checkPriority(newPriority);
        if (newPriority > ((Entry)entry).mPriority) {
            throw new IllegalArgumentException("New priority exceeds old.");
        }
        this.decreaseKeyUnchecked(entry, newPriority);
    }

    public void delete(Entry<T> entry) {
        this.decreaseKeyUnchecked(entry, Double.NEGATIVE_INFINITY);
        this.dequeueMin();
    }

    private void checkPriority(double priority) {
        if (Double.isNaN(priority)) {
            throw new IllegalArgumentException(String.valueOf(priority) + " is invalid.");
        }
    }

    private static <T> Entry<T> mergeLists(Entry<T> one, Entry<T> two) {
        if (one == null && two == null) {
            return null;
        }
        if (one != null && two == null) {
            return one;
        }
        if (one == null && two != null) {
            return two;
        }
        Entry oneNext = ((Entry)one).mNext;
        ((Entry)one).mNext = ((Entry)two).mNext;
        ((Entry)one).mNext.mPrev = (Entry)one;
        ((Entry)two).mNext = oneNext;
        ((Entry)two).mNext.mPrev = (Entry)two;
        return ((Entry)one).mPriority < ((Entry)two).mPriority ? one : two;
    }

    private void decreaseKeyUnchecked(Entry<T> entry, double priority) {
        ((Entry)entry).mPriority = priority;
        if (((Entry)entry).mParent != null && ((Entry)entry).mPriority <= ((Entry)entry).mParent.mPriority) {
            this.cutNode(entry);
        }
        if (((Entry)entry).mPriority <= ((Entry)this.mMin).mPriority) {
            this.mMin = entry;
        }
    }

    private void cutNode(Entry<T> entry) {
        ((Entry)entry).mIsMarked = false;
        if (((Entry)entry).mParent == null) {
            return;
        }
        if (((Entry)entry).mNext != entry) {
            ((Entry)entry).mNext.mPrev = ((Entry)entry).mPrev;
            ((Entry)entry).mPrev.mNext = ((Entry)entry).mNext;
        }
        if (((Entry)entry).mParent.mChild == entry) {
            if (((Entry)entry).mNext != entry) {
                ((Entry)entry).mParent.mChild = ((Entry)entry).mNext;
            } else {
                ((Entry)entry).mParent.mChild = null;
            }
        }
        Entry entry2 = ((Entry)entry).mParent;
        entry2.mDegree = entry2.mDegree - 1;
        Entry<T> entry3 = entry;
        ((Entry)entry).mNext = (Entry)entry3;
        ((Entry)entry).mPrev = (Entry)entry3;
        this.mMin = FibonacciHeap.mergeLists(this.mMin, entry);
        if (((Entry)entry).mParent.mIsMarked) {
            this.cutNode(((Entry)entry).mParent);
        } else {
            ((Entry)entry).mParent.mIsMarked = true;
        }
        ((Entry)entry).mParent = null;
    }

    public static final class Entry<T> {
        private int mDegree = 0;
        private boolean mIsMarked = false;
        private Entry<T> mNext = this.mPrev = this;
        private Entry<T> mPrev;
        private Entry<T> mParent;
        private Entry<T> mChild;
        private T mElem;
        private double mPriority;

        public T getValue() {
            return this.mElem;
        }

        public void setValue(T value) {
            this.mElem = value;
        }

        public double getPriority() {
            return this.mPriority;
        }

        private Entry(T elem, double priority) {
            this.mElem = elem;
            this.mPriority = priority;
        }
    }
}

